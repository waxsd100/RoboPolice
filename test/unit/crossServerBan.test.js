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

  test('Audit Log fallback (viewAuditLog WITHOUT banMembers) collects other-guild BANs, excludes unbanned users, and powers similarity checks', async () => {
    configureGateway()
    const now = new Date('2026-11-26T18:00:00Z')
    const toSnowflake = iso => String((BigInt(Date.parse(iso) - 1420070400000) << 22n) + 1n)
    const bannedID = '740000000000000001'
    const unbannedID = '740000000000000002'
    const joinerID = '740000000000000099'

    installAltDetectionStore({ enabled: { G_A: true }, profiles: [] })

    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', botPerms: ['viewAuditLog', 'viewChannel', 'sendMessages'] })
    // Guild B grants ONLY viewAuditLog (NO banMembers!), matching RoboPolice /setup + Wick Bot setups
    const guildB = makeGuild({ id: 'G_B', name: '提携鯖B', modChannelID: 'C_MOD_B', botPerms: ['viewAuditLog', 'viewChannel', 'sendMessages'] })
    const posted = []
    global.bot = {
      user: { id: 'BOT1', username: 'RoboPolice', dynamicAvatarURL: () => 'https://cdn.discordapp.com/avatars/bot/a.png' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path === '/guilds/G_B/audit-logs?action_type=22&limit=100') {
            return {
              audit_log_entries: [
                { id: toSnowflake('2026-11-26T17:30:00Z'), target_id: bannedID, action_type: 22, reason: '監査ログBAN: 晒し荒らし' },
                { id: toSnowflake('2026-11-26T15:00:00Z'), target_id: unbannedID, action_type: 22, reason: '誤BAN' }
              ],
              users: [
                { id: bannedID, username: 'audit_troll', global_name: '監査トロール', avatar: 'audit_av_1', bot: false },
                { id: unbannedID, username: 'forgiven_audit', global_name: '解除済み', avatar: 'audit_av_2', bot: false }
              ]
            }
          }
          if (method === 'GET' && path === '/guilds/G_B/audit-logs?action_type=23&limit=100') {
            return {
              audit_log_entries: [
                { id: toSnowflake('2026-11-26T16:00:00Z'), target_id: unbannedID, action_type: 23 }
              ],
              users: []
            }
          }
          return null
        }
      }
    }

    // 1. fetchOtherGuildBannedUsers returns only the still-banned user with exact BAN timestamp
    const fetched = await crossServerBan.fetchOtherGuildBannedUsers('G_A', { now: now.getTime() })
    assert.equal(fetched.length, 1)
    assert.equal(fetched[0].userID, bannedID)
    assert.equal(fetched[0].globalName, '監査トロール')
    assert.equal(fetched[0].moderationReason, '監査ログBAN: 晒し荒らし')
    assert.ok(fetched[0].statusAt instanceof Date)

    // 2. findOtherGuildBans also finds exact-ID ban via audit_log without banMembers
    const exact = await crossServerBan.findOtherGuildBans(bannedID, 'G_A', { now: now.getTime() })
    assert.equal(exact.length, 1)
    assert.equal(exact[0].source, 'audit_log')
    assert.equal((await crossServerBan.findOtherGuildBans(unbannedID, 'G_A', { now: now.getTime() })).length, 0)

    // 3. Similar user joining Guild A is caught against Guild B's audit-log BAN
    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 90,
        summary: '提携鯖Bの監査ログでBANされたアカウントと名前・アバターが一致します。',
        matching_evidence: ['アバター一致', '名前酷似'],
        counter_evidence: []
      })
    }]])

    const res = await altDetector.onMemberJoin(guildA, {
      id: joinerID,
      username: 'audit_troll_sub',
      user: { id: joinerID, username: 'audit_troll_sub', avatar: 'audit_av_1', createdAt: Date.parse('2025-01-01T00:00:00Z') },
      joinedAt: now.getTime()
    }, { now })
    assert.equal(res.alerted, true)
    assert.equal(geminiReqs.length, 1)
    assert.equal(posted.length, 1)
    assert.match(posted[0].payload.embeds[0].description, /提携鯖B/)
  })

  test('paginated /guilds/:id/bans fetches modern bans beyond page 1 and syncAllGuildBans persists them to Postgres for multi-shard workers', async () => {
    const storeState = installAltDetectionStore({ profiles: [] })
    const guildA = makeGuild({ id: 'G_A', name: '鯖A', botPerms: ['viewChannel'] })
    const guildB = makeGuild({ id: 'G_B', name: '大規模鯖B', botPerms: ['banMembers', 'viewChannel'] })

    const pathsCalled = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      requestHandler: {
        request: async (method, path) => {
          pathsCalled.push(path)
          if (method === 'GET' && path === '/guilds/G_B/bans?limit=2') {
            return [
              { reason: '古いBAN1', user: { id: '100000000000000001', username: 'old_2016_a' } },
              { reason: '古いBAN2', user: { id: '100000000000000002', username: 'old_2016_b' } }
            ]
          }
          if (method === 'GET' && path === '/guilds/G_B/bans?limit=2&after=100000000000000002') {
            return [
              { reason: '最近の荒らし', user: { id: '900000000000000099', username: 'modern_raider', global_name: '最新荒らし', avatar: 'mod_av' } }
            ]
          }
          if (method === 'GET' && path === '/guilds/G_B/bans?limit=1000') {
            return [
              { reason: '最近の荒らし', user: { id: '900000000000000099', username: 'modern_raider', global_name: '最新荒らし', avatar: 'mod_av' } }
            ]
          }
          return null
        }
      }
    }

    const fetched = await crossServerBan.fetchOtherGuildBannedUsers('G_A', { limitPerGuild: 2 })
    assert.equal(fetched.length, 3)
    assert.ok(fetched.some(p => p.userID === '900000000000000099' && p.username === 'modern_raider'))
    assert.ok(pathsCalled.includes('/guilds/G_B/bans?limit=2&after=100000000000000002'))

    // Now sync into DB (simulating startup sync on shard hosting G_B)
    const syncRes = await crossServerBan.syncAllGuildBans({ forceRefresh: true })
    assert.equal(syncRes.guildsSynced, 1)
    assert.equal(syncRes.totalUpserted, 1)
    assert.equal(storeState.profiles.get('G_B:900000000000000099')?.status, 'banned')
    assert.equal(storeState.profiles.get('G_B:900000000000000099')?.globalName, '最新荒らし')

    // Simulate another shard worker that ONLY has guildA in memory (not guildB): still sees G_B's ban via DB!
    global.bot.guilds = new Map([[guildA.id, guildA]])
    crossServerBan.resetRuntimeState()
    const loadedFromDb = await altDetector.loadCrossGuildBannedProfiles('G_A')
    assert.ok(loadedFromDb.some(p => p.userID === '900000000000000099' && p.guildID === 'G_B'))
  })

  test('Eris global_name REST enrichment + Japanese Katakana/Hiragana, decorations, and 2-char CJK normalization detect display-name alts on join', async () => {
    // 1. Direct nameSimilarity unit assertions for Japanese normalization
    assert.equal(altDetector.nameSimilarity({ globalName: 'クロアラシ' }, { globalName: 'くろあらし' }).score, 1)
    assert.ok(altDetector.nameSimilarity({ globalName: '★山田サブ★' }, { globalName: '山田' }).score >= 0.9)
    assert.ok(altDetector.nameSimilarity({ globalName: '【公式】くろあらし2代目' }, { globalName: 'クロアラシ' }).score >= 0.85)
    assert.ok(altDetector.nameSimilarity({ globalName: 'みうら' }, { globalName: 'さとう' }).score < 0.3)

    // 2. End-to-end onMemberJoin where Eris drops member.user.globalName and account is >1yr old
    configureGateway()
    const now = new Date('2026-11-26T12:00:00Z')
    const bannedID = '750000000000000001'
    const joinerID = '750000000000000099'
    installAltDetectionStore({
      enabled: { G_A: true },
      profiles: [{
        guildID: 'G_B',
        guildName: '他鯖B',
        userID: bannedID,
        username: 'completely_old_handle',
        globalName: 'くろあらし',
        avatarHash: 'old_av',
        status: 'banned',
        statusAt: null, // historical /bans entry without timestamp!
        moderationReason: 'スパム'
      }]
    })

    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A' })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: {
        request: async (method, path) => {
          // Discord REST GET /users/:id returns the real global_name that Eris 0.17 drops
          if (method === 'GET' && path === `/users/${joinerID}`) {
            return { id: joinerID, username: 'brand_new_handle', global_name: '★クロアラシサブ★', avatar: 'different_av' }
          }
          return null
        }
      }
    }

    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 88,
        summary: '表示名がカタカナ/ひらがな表記ゆれで一致しています。',
        matching_evidence: ['表示名一致 (★クロアラシサブ★ / くろあらし)'],
        counter_evidence: []
      })
    }]])

    // Old account (> 1 year old) + historical ban (statusAt: null) -> exact/near-exact display name gives score 30 >= crossGuildJoinAiThreshold (30)
    const joinerWithoutErisGlobalName = {
      id: joinerID,
      username: 'brand_new_handle',
      user: {
        id: joinerID,
        username: 'brand_new_handle',
        avatar: 'different_av',
        createdAt: Date.parse('2024-01-01T00:00:00Z')
      },
      joinedAt: now.getTime()
    }

    const res = await altDetector.onMemberJoin(guildA, joinerWithoutErisGlobalName, { now })
    assert.equal(res.alerted, true, 'must catch old account matching historical cross-server ban via REST global_name + Japanese normalization')
    assert.equal(geminiReqs.length, 1)
    assert.equal(posted.length, 1)
  })

  test('onMemberJoin catches exact custom avatar match (35 pts) on an old account against historical cross-server ban (statusAt: null)', async () => {
    configureGateway()
    const now = new Date('2026-11-26T12:00:00Z')
    const bannedID = '760000000000000001'
    const joinerID = '760000000000000099'
    installAltDetectionStore({ enabled: { G_A: true }, profiles: [] })

    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A' })
    const guildB = makeGuild({ id: 'G_B', name: '他鯖B', botPerms: ['banMembers'] })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path.startsWith('/guilds/G_B/bans?')) {
            return [{ reason: '荒らし', user: { id: bannedID, username: 'alpha_orig', avatar: 'identical_custom_hash' } }]
          }
          return null
        }
      }
    }
    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 86,
        summary: 'カスタムアバター画像ハッシュが完全一致しています。',
        matching_evidence: ['カスタムアバター完全一致'],
        counter_evidence: ['ユーザー名が異なる']
      })
    }]])

    const res = await altDetector.onMemberJoin(guildA, {
      id: joinerID,
      username: 'totally_unrelated_name',
      user: {
        id: joinerID,
        username: 'totally_unrelated_name',
        avatar: 'identical_custom_hash',
        createdAt: Date.parse('2023-06-01T00:00:00Z')
      },
      joinedAt: now.getTime()
    }, { now })
    assert.equal(res.alerted, true, '35-pt custom avatar match must exceed crossGuildJoinAiThreshold (30)')
    assert.equal(geminiReqs.length, 1)
    assert.equal(posted.length, 1)
  })

  test('altDetector.onMessage loads past messages of REST-discovered cross-guild banned users even when _fromDB is false', async () => {
    configureGateway()
    const now = new Date('2026-11-26T16:00:00Z')
    const restBannedID = '770000000000000001'
    const disguisedID = '770000000000000099'

    const sharedLines = [
      'ていうか運営さぁマジでそれおかしくない？やっぱ俺だけじゃなくてみんな思ってるよなwww',
      'なんかさぁ普通に考えてありえないんだよね、そもそも説明不足すぎるんだよなwww',
      'いやマジでさぁなんで消したのか意味わかんないんだけど、やっぱ都合悪いんかなwww',
      'てかさぁ個人的には最初からずっと言ってるんだけど誰も聞いてないよなwww',
      'そもそも普通にルール読めばわかる話なんだよな、マジで草なんだわwww'
    ]

    // Note: restBannedID has NO row in member_activity_profiles (discovered ONLY via REST /bans -> _fromDB: false!),
    // yet HAS historical messages stored in Postgres `messages` for G_B!
    installAltDetectionStore({
      enabled: { G_A: true },
      profiles: [{
        guildID: 'G_A',
        userID: disguisedID,
        username: 'disguised_newbie',
        status: 'active',
        joinedAt: new Date('2026-11-26T15:00:00Z')
      }],
      messages: [
        ...sharedLines.map((content, i) => ({
          id: `rb_${i}`,
          guildID: 'G_B',
          authorID: restBannedID,
          channelID: 'C_B1',
          content,
          ts: new Date(Date.parse('2026-11-20T10:00:00Z') + i * 120000)
        })),
        ...sharedLines.slice(0, 4).map((content, i) => ({
          id: `da_${i}`,
          guildID: 'G_A',
          authorID: disguisedID,
          channelID: 'C_A1',
          content: content.replace('運営', '管理'),
          ts: new Date(now.getTime() - (5 - i) * 120000)
        }))
      ]
    })

    const disguisedMember = {
      id: disguisedID,
      username: 'disguised_newbie',
      user: { id: disguisedID, username: 'disguised_newbie' },
      joinedAt: Date.parse('2026-11-26T15:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [disguisedMember] })
    const guildB = makeGuild({ id: 'G_B', name: '他鯖B', botPerms: ['banMembers'] })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path.startsWith('/guilds/G_B/bans?')) {
            return [{ reason: '荒らし', user: { id: restBannedID, username: 'totally_other_user' } }]
          }
          return null
        }
      }
    }

    const geminiReqs = installGemini([[{
      text: JSON.stringify({
        verdict: 'likely_alt',
        confidence: 87,
        summary: 'RESTから取得した他鯖BAN者の過去発言と文体が一致しています。',
        matching_evidence: ['助詞・文末パターン一致'],
        counter_evidence: ['名前が異なる']
      })
    }]])

    let lastRes = null
    for (let i = 0; i < 5; i++) {
      lastRes = await altDetector.onMessage({
        id: `da_${i}`,
        author: { id: disguisedID, username: 'disguised_newbie', bot: false },
        member: disguisedMember,
        channel: { id: 'C_A1', guild: guildA },
        content: sharedLines[i].replace('運営', '管理'),
        timestamp: now.getTime() - (4 - i) * 60000
      }, { now })
    }
    assert.equal(lastRes.alerted, true, 'must load messages for REST-discovered cross-guild banned account even with _fromDB=false')
    assert.equal(geminiReqs.length, 1)
    assert.equal(posted.length, 1)
  })

  test('scanServer prefilter catches cross-server lookalike past member #200 and scanGuildForCrossServerBans catches Audit-Log banned members', async () => {
    const now = new Date('2026-11-26T18:00:00Z')
    const toSnowflake = iso => String((BigInt(Date.parse(iso) - 1420070400000) << 22n) + 1n)
    const auditBannedID = '780000000000000001'
    const exactBannedPresentID = '780000000000000002'
    const lateLookalikeID = '780000000000000320'

    installAltDetectionStore({ profiles: [] })

    // Build 325 active members; put the lookalike at index #320 (well beyond the old 200-member slice!)
    const members = []
    for (let i = 1; i <= 325; i++) {
      if (i === 320) {
        members.push({
          id: lateLookalikeID,
          username: 'kuro_arashi_alt',
          user: { id: lateLookalikeID, username: 'kuro_arashi_alt', avatar: 'shared_av_320', createdAt: Date.parse('2024-01-01T00:00:00Z') },
          joinedAt: Date.parse('2025-05-01T00:00:00Z')
        })
      } else if (i === 310) {
        members.push({
          id: exactBannedPresentID,
          username: 'already_here_banned',
          user: { id: exactBannedPresentID, username: 'already_here_banned', createdAt: Date.parse('2024-01-01T00:00:00Z') },
          joinedAt: Date.parse('2025-04-01T00:00:00Z')
        })
      } else {
        const uid = String(780000000000001000n + BigInt(i))
        members.push({
          id: uid,
          username: `regular_member_${i}`,
          user: { id: uid, username: `regular_member_${i}`, createdAt: Date.parse('2024-01-01T00:00:00Z') },
          joinedAt: Date.parse('2026-11-25T00:00:00Z') - i * 1000
        })
      }
    }

    const guildA = makeGuild({ id: 'G_A', name: '大規模本鯖', modChannelID: 'C_MOD_A', members, botPerms: ['viewAuditLog'] })
    const guildB = makeGuild({ id: 'G_B', name: '他鯖B', botPerms: ['viewAuditLog'] })

    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      requestHandler: {
        request: async (method, path) => {
          if (method === 'GET' && path === '/guilds/G_B/audit-logs?action_type=22&limit=100') {
            return {
              audit_log_entries: [
                { id: toSnowflake('2026-11-20T00:00:00Z'), target_id: auditBannedID, action_type: 22, reason: '荒らし' },
                { id: toSnowflake('2026-11-21T00:00:00Z'), target_id: exactBannedPresentID, action_type: 22, reason: 'スパム' }
              ],
              users: [
                { id: auditBannedID, username: 'kuro_arashi', avatar: 'shared_av_320', bot: false },
                { id: exactBannedPresentID, username: 'already_here_banned', bot: false }
              ]
            }
          }
          if (method === 'GET' && path === '/guilds/G_B/audit-logs?action_type=23&limit=100') {
            return { audit_log_entries: [], users: [] }
          }
          return null
        }
      }
    }

    const scanRes = await altDetector.scanServer(guildA, { scope: 'ban_evasion', aiVerifyTop: 0, fetchLiveChannels: false, now })
    assert.equal(scanRes.scannedActive, 325)
    assert.ok(
      scanRes.pairs.some(p => p.suspectProfile.userID === lateLookalikeID && p.candidateProfile.userID === auditBannedID),
      'scanServer inverted prefilter must catch matching member at index #320'
    )

    const exactHits = await crossServerBan.scanGuildForCrossServerBans(guildA, { now: now.getTime() })
    assert.ok(
      exactHits.some(h => h.userID === exactBannedPresentID && h.bans[0].guildID === 'G_B'),
      'scanGuildForCrossServerBans must catch existing members banned in other guilds via Audit Log'
    )
  })

  test('zero-AI-cost high-confidence cross-server lookalike fallback alerts on join when alt_detection is OFF (no duplicate when ON) and on guildBanAdd', async () => {
    const now = new Date('2026-11-26T18:00:00Z')
    const bannedID = '790000000000000001'
    const lookalikeID = '790000000000000099'
    const existingAltID = '790000000000000088'
    const storeState = installAltDetectionStore({
      enabled: { G_A: false },
      profiles: [{
        guildID: 'G_B',
        guildName: '姉妹鯖B',
        userID: bannedID,
        username: 'raid_king',
        globalName: '荒らし王',
        avatarHash: 'raid_king_av',
        status: 'banned',
        moderationReason: 'レイド実行'
      }]
    })

    const existingAltMember = {
      id: existingAltID,
      username: 'fresh_ban_alt',
      user: { id: existingAltID, username: 'fresh_ban_alt', avatar: 'fresh_ban_av', createdAt: Date.parse('2025-01-01T00:00:00Z') },
      joinedAt: Date.parse('2026-11-01T00:00:00Z')
    }
    const guildA = makeGuild({ id: 'G_A', name: '本鯖', modChannelID: 'C_MOD_A', members: [existingAltMember], botPerms: ['viewChannel', 'sendMessages'] })
    const guildB = makeGuild({ id: 'G_B', name: '姉妹鯖B', botPerms: ['viewChannel'] })
    const posted = []
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      guilds: new Map([[guildA.id, guildA], [guildB.id, guildB]]),
      createMessage: async (chID, payload) => { posted.push({ chID, payload }) },
      requestHandler: { request: async () => null }
    }
    const geminiReqs = installGemini([])

    // 1. When alt_detection is OFF, high-confidence lookalike join alerts mod channel with ZERO AI calls
    const resOff = await crossServerBan.onMemberJoin(guildA, {
      id: lookalikeID,
      username: 'raid_king_sub',
      user: { id: lookalikeID, username: 'raid_king_sub', avatar: 'raid_king_av', createdAt: Date.parse('2024-01-01T00:00:00Z') },
      joinedAt: now.getTime()
    }, { now })
    assert.equal(resOff.alerted, true)
    assert.equal(geminiReqs.length, 0, 'zero AI calls in lookalike fallback')
    assert.equal(posted.length, 1)
    assert.match(posted[0].payload.embeds[0].title, /他サーバーBAN者との類似アカウント検知/)

    // 2. When alt_detection is ON, crossServerBan.onMemberJoin defers lookalikes to altDetector (no duplicate alert)
    storeState.enabled.G_A = true
    const resOn = await crossServerBan.onMemberJoin(guildA, {
      id: '790000000000000077',
      username: 'raid_king_3',
      user: { id: '790000000000000077', username: 'raid_king_3', avatar: 'raid_king_av' },
      joinedAt: now.getTime()
    }, { now })
    assert.equal(resOn.alerted, false, 'defers to altDetector when alt_detection is enabled')
    assert.equal(posted.length, 1)

    // 3. When someone is banned in G_B and a high-confidence lookalike is ALREADY in G_A, onGuildBan alerts G_A
    const banRes = await crossServerBan.onGuildBan(
      guildB,
      { id: '790000000000000055', username: 'fresh_ban_main', avatar: 'fresh_ban_av' },
      { reason: '荒らし連投', at: now }
    )
    assert.equal(banRes.similarAlertedGuilds.length, 1)
    assert.equal(banRes.similarAlertedGuilds[0].guildID, 'G_A')
    assert.equal(banRes.similarAlertedGuilds[0].memberUserID, existingAltID)
    assert.equal(posted.length, 2)
    assert.match(posted[1].payload.embeds[0].title, /他サーバーBAN者との類似アカウント検知/)
  })
})
