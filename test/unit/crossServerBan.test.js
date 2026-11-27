const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const crossServerBan = require('../../src/bot/modules/crossServerBan')
const altDetector = require('../../src/bot/modules/altDetector')
const wickModeration = require('../../src/bot/modules/wickModeration')
const altcheck = require('../../src/bot/slashcommands/altcheck')
const { installAltDetectionStore, configureGateway, installGemini } = require('../helpers/fakes')

const SAVED_ENV_KEYS = [
  'CROSS_GUILD_BAN_ALERT',
  'CROSS_GUILD_ALT_DETECTION',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_AI_GATEWAY_ID',
  'GEMINI_API_KEY'
]

function makePerms (allowed = []) {
  const set = new Set(allowed)
  return {
    has: p => set.has(p),
    json: Object.fromEntries(allowed.map(p => [p, true]))
  }
}

function makeGuild ({ id, name, modChannelID = null, members = [], botPerms = ['banMembers', 'viewChannel', 'sendMessages'] }) {
  const memberMap = new Map()
  memberMap.set('BOT1', { id: 'BOT1', username: 'RoboPolice', bot: true, permissions: makePerms(botPerms) })
  for (const m of members) memberMap.set(m.id, m)

  const channels = new Map()
  if (modChannelID) {
    channels.set(modChannelID, {
      id: modChannelID,
      name: 'mod-alerts',
      type: 0,
      guild: { id },
      permissionsOf: () => makePerms(['viewChannel', 'sendMessages', 'readMessageHistory'])
    })
  }
  return {
    id,
    name,
    ownerID: 'OWNER1',
    publicUpdatesChannelID: modChannelID,
    channels,
    roles: new Map(),
    members: memberMap
  }
}

describe('crossServerBan', () => {
  let prevBot
  let prevFetch
  let prevEnv

  beforeEach(() => {
    prevBot = global.bot
    prevFetch = global.fetch
    prevEnv = Object.fromEntries(SAVED_ENV_KEYS.map(k => [k, process.env[k]]))
    delete process.env.CROSS_GUILD_BAN_ALERT
    delete process.env.CROSS_GUILD_ALT_DETECTION
    crossServerBan.resetRuntimeState()
    altDetector.resetRuntimeState()
    wickModeration.resetRuntimeState()
  })

  afterEach(() => {
    global.bot = prevBot
    global.fetch = prevFetch
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    crossServerBan.resetRuntimeState()
    altDetector.resetRuntimeState()
    wickModeration.resetRuntimeState()
    installAltDetectionStore()
  })

  test('onMemberJoin warns mod channel via live Discord ban check (even without prior DB row), backfills DB, and respects cooldown', async () => {
    const userID = '111111111111111111'
    const storeState = installAltDetectionStore({ profiles: [] })

    const guildA = makeGuild({ id: 'G_A', name: 'メイン鯖', modChannelID: 'C_MOD_A' })
    const guildB = makeGuild({ id: 'G_B', name: '別コミュニティ鯖', modChannelID: 'C_MOD_B' })

    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => {
        posted.push({ chID, payload })
      },
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path === `/guilds/G_B/bans/${userID}`) {
            return { reason: '大規模スパム荒らし', user: { id: userID, username: 'raider_x' } }
          }
          const err = new Error('Unknown Ban')
          err.code = 10026
          err.status = 404
          throw err
        }
      }
    }

    const joiningMember = {
      id: userID,
      username: 'raider_x',
      user: { id: userID, username: 'raider_x', globalName: '荒らしX' },
      joinedAt: Date.now()
    }

    const res = await crossServerBan.onMemberJoin(guildA, joiningMember)
    assert.equal(res.checked, true)
    assert.equal(res.alerted, true)
    assert.equal(res.bans.length, 1)
    assert.equal(res.bans[0].guildID, 'G_B')
    assert.equal(res.bans[0].source, 'live')

    assert.equal(posted.length, 1)
    assert.equal(posted[0].chID, 'C_MOD_A')
    const embed = posted[0].payload.embeds[0]
    assert.match(embed.title, /他サーバーBAN警告/)
    const banField = embed.fields.find(f => f.name.includes('他サーバーでのBAN履歴'))
    assert.match(banField.value, /別コミュニティ鯖/)
    assert.match(banField.value, /大規模スパム荒らし/)
    assert.match(banField.value, /リアルタイム確認済み/)
    const wickField = embed.fields.find(f => f.name.includes('Wick'))
    assert.match(wickField.value, /\/ban add user:111111111111111111 reason:/)
    assert.match(wickField.value, /\/quarantine add user:111111111111111111/)
    assert.match(wickField.value, /\/cases view user:111111111111111111/)

    // Wait a tick for async DB backfill
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(storeState.profiles.get(`G_B:${userID}`)?.status, 'banned')

    // Re-joining immediately should hit cooldown and not spam another alert
    const repeat = await crossServerBan.onMemberJoin(guildA, joiningMember)
    assert.equal(repeat.alerted, false)
    assert.equal(repeat.reason, 'cooldown')
    assert.equal(posted.length, 1)
  })

  test('findOtherGuildBans drops stale DB ban record when live check confirms 404 Unknown Ban', async () => {
    const userID = '222222222222222222'
    const storeState = installAltDetectionStore({
      profiles: [{
        guildID: 'G_B',
        guildName: '他鯖B',
        userID,
        username: 'forgiven_user',
        status: 'banned',
        moderationReason: '誤BAN'
      }]
    })

    const guildA = makeGuild({ id: 'G_A', name: '鯖A', modChannelID: 'C_MOD_A' })
    const guildB = makeGuild({ id: 'G_B', name: '他鯖B', modChannelID: 'C_MOD_B' })
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      requestHandler: {
        request: async () => {
          const err = new Error('Unknown Ban')
          err.code = 10026
          err.status = 404
          throw err
        }
      }
    }

    const bans = await crossServerBan.findOtherGuildBans(userID, 'G_A', { includeLiveCheck: true })
    assert.equal(bans.length, 0, 'unbanned user must not trigger false warning')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(storeState.profiles.get(`G_B:${userID}`)?.status, 'left')
  })

  test('onGuildBan alerts other servers where the newly banned user is ALREADY a member', async () => {
    const userID = '333333333333333333'
    installAltDetectionStore()

    const existingMember = {
      id: userID,
      username: 'sleeper_troll',
      user: { id: userID, username: 'sleeper_troll' },
      joinedAt: Date.parse('2026-10-01T00:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [existingMember] })
    const guildB = makeGuild({ id: 'G_B', name: '姉妹鯖', modChannelID: 'C_MOD_B' })
    const guildC = makeGuild({ id: 'G_C', name: '関係ない鯖', modChannelID: 'C_MOD_C' })

    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB], [guildC.id, guildC]]),
      createMessage: async (chID, payload) => {
        posted.push({ chID, payload })
      }
    }

    const res = await crossServerBan.onGuildBan(guildB, { id: userID, username: 'sleeper_troll' }, { reason: 'NSFW荒らし連投' })
    assert.equal(res.alertedGuilds.length, 1)
    assert.equal(res.alertedGuilds[0].guildID, 'G_A')
    assert.equal(posted.length, 1)
    assert.equal(posted[0].chID, 'C_MOD_A')
    assert.match(posted[0].payload.embeds[0].title, /在籍中メンバーが他鯖でBAN/)
    assert.match(posted[0].payload.embeds[0].fields[1].value, /姉妹鯖/)
    assert.match(posted[0].payload.embeds[0].fields[1].value, /NSFW荒らし連投/)
  })

  test('altDetector.onMemberUnban downgrades banned profile so unbanned users stop showing up', async () => {
    const userID = '444444444444444444'
    const storeState = installAltDetectionStore({
      profiles: [{
        guildID: 'G_B',
        userID,
        username: 'rehabilitated',
        status: 'banned',
        moderationReason: '一時的誤解'
      }]
    })
    await altDetector.onMemberUnban({ id: 'G_B' }, { id: userID, username: 'rehabilitated' })
    assert.equal(storeState.profiles.get(`G_B:${userID}`)?.status, 'left')
    const bans = await crossServerBan.findOtherGuildBans(userID, 'G_A', { includeLiveCheck: false })
    assert.equal(bans.length, 0)
  })

  test('buildModerationDossier and /altcheck find & scan surface cross-server BANs', async () => {
    const userID = '555555555555555555'
    installAltDetectionStore({
      profiles: [{
        guildID: 'G_OTHER',
        guildName: '別鯖X',
        userID,
        username: 'cross_banned',
        status: 'banned',
        statusAt: new Date('2026-11-20T00:00:00Z'),
        moderationReason: '個人情報晒し'
      }]
    })

    const member = {
      id: userID,
      username: 'cross_banned',
      user: { id: userID, username: 'cross_banned' },
      roles: [],
      joinedAt: Date.parse('2026-11-25T00:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [member] })
    const guildOther = makeGuild({ id: 'G_OTHER', name: '別鯖X', botPerms: [] })

    global.bot = {
      user: { id: 'BOT1', username: 'RoboPolice', dynamicAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot/a.png' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildOther.id, guildOther]]),
      getMessages: async () => [],
      requestHandler: { request: async () => null }
    }

    // 1. Moderation dossier includes cross-server BAN history
    const dossier = await wickModeration.buildModerationDossier(guildA, userID)
    assert.match(dossier, /他サーバーでBANされています（1件）/)
    assert.match(dossier, /別鯖X \(G_OTHER\).*個人情報晒し/)

    // 2. /altcheck find shows cross-server BAN field and red alert color
    const findReplies = []
    await altcheck.func({
      guildID: guildA.id,
      locale: 'ja',
      data: { options: [{ name: 'find', type: 1, options: [{ name: 'user', value: userID }] }] },
      defer: async () => {},
      editOriginalMessage: async payload => { findReplies.push(payload) },
      createMessage: async payload => { findReplies.push(payload) }
    })
    assert.equal(findReplies.length, 1)
    const findEmbed = findReplies[0].embeds[0]
    assert.ok(findEmbed.fields.some(f => f.name.includes('他サーバーでのBAN履歴') && f.value.includes('別鯖X')))

    // 3. /altcheck scan detects currently present members banned in other servers
    const scanReplies = []
    await altcheck.func({
      guildID: guildA.id,
      locale: 'ja',
      data: { options: [{ name: 'scan', type: 1, options: [] }] },
      defer: async () => {},
      editOriginalMessage: async payload => { scanReplies.push(payload) },
      createMessage: async payload => { scanReplies.push(payload) }
    })
    assert.equal(scanReplies.length, 1)
    const scanEmbed = scanReplies[0].embeds[0]
    assert.ok(scanEmbed.fields.some(f => f.name.includes('他サーバーでBANされている在籍メンバー') && f.value.includes('別鯖X')))
  })

  test('CROSS_GUILD_BAN_ALERT=false disables automatic cross-server warnings', async () => {
    process.env.CROSS_GUILD_BAN_ALERT = 'false'
    const userID = '666666666666666666'
    installAltDetectionStore({
      profiles: [{ guildID: 'G_B', userID, status: 'banned', moderationReason: '荒らし' }]
    })
    const guildA = makeGuild({ id: 'G_A', name: '鯖A', modChannelID: 'C_MOD_A' })
    const res = await crossServerBan.onMemberJoin(guildA, { id: userID, username: 'u' })
    assert.equal(res.checked, false)
    assert.equal(res.alerted, false)
  })

  test('altDetector.onMemberJoin catches a different account similar to a historically banned user in another server via REST ban list', async () => {
    configureGateway()
    const now = new Date('2026-11-26T12:00:00Z')
    const otherBannedID = '700000000000000001'
    const newJoinerID = '700000000000000099'
    installAltDetectionStore({ enabled: { G_A: true }, profiles: [] })

    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A' })
    const guildB = makeGuild({ id: 'G_B', name: '姉妹鯖B', modChannelID: 'C_MOD_B' })
    const posted = []
    let banListCalls = 0
    global.bot = {
      user: { id: 'BOT1', username: 'RoboPolice', dynamicAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot/a.png' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path.startsWith('/guilds/G_B/bans?')) {
            banListCalls++
            return [{
              reason: '他鯖での悪質荒らし',
              user: { id: otherBannedID, username: 'kuro_arashi', global_name: 'くろあらし', avatar: 'same_custom_av' }
            }]
          }
          return null
        }
      }
    }

    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 91,
        summary: '姉妹鯖BでBANされたアカウントと名前およびカスタムアバターが強く一致しています。',
        matching_evidence: ['カスタムアバターハッシュが完全一致', 'ユーザー名が酷似 (kuro_arashi / kuro_arashi_sub)'],
        counter_evidence: ['まだ本鯖での発言がない']
      })
    }]])

    const joiner = {
      id: newJoinerID,
      username: 'kuro_arashi_sub',
      user: {
        id: newJoinerID,
        username: 'kuro_arashi_sub',
        globalName: 'くろあらし2',
        avatar: 'same_custom_av',
        createdAt: new Date('2026-11-26T10:00:00Z').getTime()
      },
      joinedAt: now.getTime()
    }

    const res = await altDetector.onMemberJoin(guildA, joiner, { now })
    assert.equal(res.alerted, true)
    assert.equal(banListCalls, 1)
    assert.equal(geminiReqs.length, 1)
    assert.match(geminiReqs[0].body.contents[0].parts[0].text, /他サーバー「姉妹鯖B」/)
    assert.equal(posted.length, 1)
    assert.equal(posted[0].chID, 'C_MOD_A')
    const embed = posted[0].payload.embeds[0]
    assert.match(embed.title, /他サーバーBAN者との類似アカウント検知/)
    assert.match(embed.description, /姉妹鯖B/)
    const wickField = embed.fields.find(f => f.name.includes('Wick'))
    assert.match(wickField.value, /\/ban add user:700000000000000099 reason:他鯖\(姉妹鯖B\)BAN者\(700000000000000001\)/)
  })

  test('cross-guild anti-false-positive gate prevents unrelated new joiners from triggering AI or alerts on timing alone', async () => {
    configureGateway()
    const now = new Date('2026-11-26T12:15:00Z')
    installAltDetectionStore({
      enabled: { G_A: true },
      profiles: [{
        guildID: 'G_B',
        guildName: '別鯖B',
        userID: '710000000000000001',
        username: 'troll_master_999',
        avatarHash: 'troll_av_1',
        status: 'banned',
        statusAt: new Date('2026-11-26T12:00:00Z'),
        moderationReason: '荒らし'
      }]
    })

    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A' })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: { request: async () => null }
    }
    const geminiReqs = installGemini([])

    const innocentNewbie = {
      id: '710000000000000099',
      username: 'haruka_music',
      user: {
        id: '710000000000000099',
        username: 'haruka_music',
        avatar: 'totally_different_av',
        createdAt: new Date('2026-11-26T11:30:00Z').getTime()
      },
      joinedAt: now.getTime()
    }

    const res = await altDetector.onMemberJoin(guildA, innocentNewbie, { now })
    assert.equal(res.alerted, false)
    assert.equal(geminiReqs.length, 0, 'zero AI calls for unrelated newbie')
    assert.equal(posted.length, 0, 'zero false alerts')
    assert.ok(res.candidates[0].heuristic.score <= 25, 'cross-guild score capped without identity/behavioral evidence')
  })

  test('altDetector.onMessage detects a completely disguised cross-server alt via stylometry, mod-deleted messages from other guild, and cross-guild embeddings', async () => {
    configureGateway()
    const now = new Date('2026-11-26T15:00:00Z')
    const bannedOtherID = '720000000000000001'
    const disguisedID = '720000000000000099'

    const bannedMsgs = [
      'ていうか運営さぁマジでそれおかしくない？やっぱ俺だけじゃなくてみんな思ってるよなwww',
      'なんかさぁ普通に考えてありえないんだよね、そもそも説明不足すぎるんだよなwww',
      'いやマジでさぁなんで消したのか意味わかんないんだけど、やっぱ都合悪いんかなwww',
      'てかさぁ個人的には最初からずっと言ってるんだけど誰も聞いてないよなwww',
      'そもそも普通にルール読めばわかる話なんだよな、マジで草なんだわwww'
    ]
    const disguisedMsgs = [
      'ていうかここの管理さぁマジでそれおかしくない？やっぱ俺だけじゃなくてみんな気づいてるよなwww',
      'なんかさぁ普通に考えてありえないんだよね、そもそも話が通じなさすぎるんだよなwww',
      'いやマジでさぁなんでそんな対応なのか意味わかんないんだけど、やっぱ都合悪いんかなwww',
      'てかさぁ個人的には前からずっと言ってるんだけど誰も見てないよなwww',
      'そもそも普通に考えればわかる話なんだよな、マジで草なんだわwww'
    ]

    installAltDetectionStore({
      enabled: { G_A: true },
      profiles: [
        {
          guildID: 'G_B',
          guildName: '他鯖B',
          userID: bannedOtherID,
          username: 'alpha_orig',
          status: 'banned',
          statusAt: new Date('2026-11-25T10:00:00Z'),
          moderationReason: '暴言・荒らし'
        },
        {
          guildID: 'G_A',
          userID: disguisedID,
          username: 'completely_different_name',
          status: 'active',
          joinedAt: new Date('2026-11-26T14:00:00Z')
        }
      ],
      messages: [
        ...disguisedMsgs.slice(0, 4).map((content, i) => ({
          id: `ma_${i}`,
          guildID: 'G_A',
          authorID: disguisedID,
          channelID: 'C_A1',
          content,
          ts: new Date(now.getTime() - (5 - i) * 120000)
        }))
      ],
      snapshots: bannedMsgs.map((content, i) => ({
        guildID: 'G_B',
        messageID: `mb_${i}`,
        authorID: bannedOtherID,
        channelID: 'C_B1',
        eventType: 'deleted',
        deletedBy: 'moderator',
        content,
        originalTs: new Date(Date.parse('2026-11-25T09:00:00Z') + i * 120000),
        eventTs: new Date('2026-11-25T09:30:00Z')
      })),
      centroids: {
        [`G_A:${disguisedID}`]: [0.9, 0.4, 0.1],
        [`G_B:${bannedOtherID}`]: [0.89, 0.42, 0.12]
      }
    })

    const disguisedMember = {
      id: disguisedID,
      username: 'completely_different_name',
      user: { id: disguisedID, username: 'completely_different_name' },
      joinedAt: Date.parse('2026-11-26T14:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [disguisedMember] })
    const guildB = makeGuild({ id: 'G_B', name: '他鯖B', botPerms: [] })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: { request: async () => null }
    }

    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 89,
        summary: '名前・アバターは全く異なりますが、他鯖BでBANされたアカウント（モデレーター削除発言含む）と口調・機能語・文末パターンが酷似しています。',
        matching_evidence: ['助詞・接続表現と文末パターンが高度に一致', '意味ベクトルが類似'],
        counter_evidence: ['名前とアバターは異なる']
      })
    }]])

    let lastRes = null
    for (let i = 0; i < 5; i++) {
      lastRes = await altDetector.onMessage({
        id: i < 4 ? `ma_${i}` : 'ma_4',
        author: { id: disguisedID, username: 'completely_different_name', bot: false },
        member: disguisedMember,
        channel: { id: 'C_A1', guild: guildA },
        content: disguisedMsgs[i],
        timestamp: now.getTime() - (4 - i) * 60000
      }, { now })
    }

    assert.equal(lastRes.alerted, true)
    assert.equal(geminiReqs.length, 1)
    assert.match(geminiReqs[0].body.contents[0].parts[0].text, /\[モデレーター削除済み\]/)
    assert.equal(posted.length, 1)
    assert.match(posted[0].payload.embeds[0].title, /他サーバーBAN者との類似アカウント検知/)
    assert.match(posted[0].payload.embeds[0].fields[1].value, /他サーバー「他鯖B」でBAN済み/)
  })

  test('buildModerationDossier, /altcheck scan, and /altcheck compare surface cross-server similar banned users', async () => {
    const bannedOtherID = '730000000000000001'
    const similarMemberID = '730000000000000099'
    installAltDetectionStore({
      profiles: [{
        guildID: 'G_OTHER',
        guildName: '姉妹鯖Y',
        userID: bannedOtherID,
        username: 'toxic_viper',
        avatarHash: 'viper_av_hash',
        status: 'banned',
        statusAt: new Date('2026-11-24T00:00:00Z'),
        moderationReason: '晒し荒らし'
      }],
      messages: [
        { id: 'o1', guildID: 'G_OTHER', authorID: bannedOtherID, channelID: 'C_O1', content: 'てかさぁ普通にありえないよなwww', ts: new Date('2026-11-23T12:00:00Z') }
      ]
    })

    const similarMember = {
      id: similarMemberID,
      username: 'toxic_viper_2',
      user: {
        id: similarMemberID,
        username: 'toxic_viper_2',
        avatar: 'viper_av_hash',
        createdAt: Date.parse('2026-11-24T06:00:00Z')
      },
      roles: [],
      joinedAt: Date.parse('2026-11-24T07:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [similarMember] })
    const guildOther = makeGuild({ id: 'G_OTHER', name: '姉妹鯖Y', botPerms: [] })

    global.bot = {
      user: { id: 'BOT1', username: 'RoboPolice', dynamicAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot/a.png' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildOther.id, guildOther]]),
      getMessages: async () => [],
      requestHandler: { request: async () => null }
    }

    // 1. buildModerationDossier warns about similar banned account even when own ID is clean
    const dossier = await wickModeration.buildModerationDossier(guildA, similarMemberID)
    assert.match(dossier, /他サーバーでBANされたユーザーとの類似候補あり/)
    assert.match(dossier, /他サーバーBAN者との類似候補（別アカウント・サブ垢の疑い）/)
    assert.match(dossier, /toxic_viper.*姉妹鯖Y.*晒し荒らし/)

    // 2. /altcheck scan discovers the cross-server similar pair
    const scanReplies = []
    await altcheck.func({
      guildID: guildA.id,
      locale: 'ja',
      data: { options: [{ name: 'scan', type: 1, options: [] }] },
      defer: async () => {},
      editOriginalMessage: async payload => { scanReplies.push(payload) },
      createMessage: async payload => { scanReplies.push(payload) }
    })
    const scanEmbed = scanReplies[0].embeds[0]
    assert.ok(scanEmbed.fields.some(f => f.value.includes('toxic_viper') && f.value.includes('他鯖「姉妹鯖Y」でBAN済み')))

    // 3. /altcheck compare resolves the cross-server banned user's profile and messages from G_OTHER
    const cmp = await altDetector.compareUsers(guildA, similarMemberID, bannedOtherID, { fetchLiveChannels: false })
    assert.equal(cmp.candidateProfile.crossGuild, true)
    assert.equal(cmp.candidateProfile.guildID, 'G_OTHER')
    assert.equal(cmp.candidateMessageCount, 1)
    assert.ok(cmp.heuristic.score >= 50)
  })
})
