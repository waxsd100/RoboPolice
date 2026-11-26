const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const crossServerBan = require('../../src/bot/modules/crossServerBan')
const altDetector = require('../../src/bot/modules/altDetector')
const wickModeration = require('../../src/bot/modules/wickModeration')
const altcheck = require('../../src/bot/slashcommands/altcheck')
const { installAltDetectionStore } = require('../helpers/fakes')

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
  let prevEnvAlert

  beforeEach(() => {
    prevBot = global.bot
    prevEnvAlert = process.env.CROSS_GUILD_BAN_ALERT
    delete process.env.CROSS_GUILD_BAN_ALERT
    crossServerBan.resetRuntimeState()
    altDetector.resetRuntimeState()
    wickModeration.resetRuntimeState()
  })

  afterEach(() => {
    global.bot = prevBot
    if (prevEnvAlert === undefined) delete process.env.CROSS_GUILD_BAN_ALERT
    else process.env.CROSS_GUILD_BAN_ALERT = prevEnvAlert
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
})
