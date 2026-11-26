const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')

const wickModeration = require('../../src/bot/modules/wickModeration')
const altDB = require('../../src/db/interfaces/postgres/altDetection')
const altDetector = require('../../src/bot/modules/altDetector')
const { createTools } = require('../../src/bot/modules/eventTools')

function makePerms (allowed = []) {
  const set = new Set(allowed)
  return {
    has: p => set.has(p),
    json: Object.fromEntries(allowed.map(p => [p, true]))
  }
}

function makeChannel ({ id, name, type = 0, permsByUser = {} }) {
  return {
    id,
    name,
    type,
    guild: { id: 'G1' },
    permissionsOf: who => {
      const uid = typeof who === 'string' ? who : (who?.id || who?.user?.id)
      const list = permsByUser[uid] ?? permsByUser['*'] ?? ['viewChannel', 'readMessageHistory']
      return makePerms(list)
    }
  }
}

describe('wickModeration', () => {
  let prevBot
  let origAltMethods

  beforeEach(() => {
    wickModeration.resetRuntimeState()
    prevBot = global.bot
    origAltMethods = {
      isAltDetectionEnabled: altDB.isAltDetectionEnabled,
      getMemberProfile: altDB.getMemberProfile,
      getCandidateProfiles: altDB.getCandidateProfiles,
      markMemberStatus: altDB.markMemberStatus,
      getMemberMessages: altDB.getMemberMessages,
      getRecentAlerts: altDB.getRecentAlerts
    }
    global.bot = {
      user: { id: 'BOT1' },
      guildSettingsCache: {},
      getChannel: () => null,
      getMessages: async () => [],
      requestHandler: { request: async () => null }
    }
  })

  afterEach(() => {
    wickModeration.resetRuntimeState()
    global.bot = prevBot
    Object.assign(altDB, origAltMethods)
  })

  test('formatWickSlashCommand produces verified Wick V5 slash commands', () => {
    assert.equal(
      wickModeration.formatWickSlashCommand('ban', { user: '123456789012345678', reason: 'ルール3違反（荒らし）', purge_days: 1, dm: true }),
      '/ban add user:123456789012345678 reason:ルール3違反（荒らし） purge_days:1 dm:true'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('ban', { user: '123456789012345678', reason: 'BAN回避', hack: true, duration: '7d' }),
      '/ban add user:123456789012345678 reason:BAN回避 duration:7d hack:true'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('unban', { user: '123456789012345678', reason: '誤BAN解除' }),
      '/ban remove user:123456789012345678 reason:誤BAN解除'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('timeout', { user: '123456789012345678', duration: '1h', reason: '暴言\n`連投`' }),
      '/timeout add user:123456789012345678 duration:1h reason:暴言 連投'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('untimeout', { user: '123456789012345678' }),
      '/timeout remove user:123456789012345678'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('kick', { user: '123456789012345678', reason: 'ルール2違反' }),
      '/kick user:123456789012345678 reason:ルール2違反'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('warn', { user: '123456789012345678', reason: 'スパム警告' }),
      '/warn user:123456789012345678 reason:スパム警告'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('quarantine', { user: '123456789012345678', reason: '調査中' }),
      '/quarantine add user:123456789012345678 reason:調査中'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('cases', { user: '123456789012345678', type: 'Warn' }),
      '/cases view user:123456789012345678 type:Warn'
    )
    assert.equal(
      wickModeration.formatWickSlashCommand('notes', { user: '123456789012345678', msg: '要注意ユーザー' }),
      '/notes add user:123456789012345678 msg:要注意ユーザー'
    )
  })

  test('parseWickLogMessage extracts fields and separates target user from moderator', () => {
    const targetID = '111111111111111111'
    const modID = '222222222222222222'
    const wickMsg = {
      id: '9001',
      timestamp: Date.parse('2026-11-20T12:00:00Z'),
      author: { id: wickModeration.WICK_BOT_ID, username: 'Wick', bot: true },
      embeds: [{
        title: 'Timeout | Case #42',
        fields: [
          { name: 'User', value: `<@${targetID}> (${targetID})` },
          { name: 'Moderator', value: `<@${modID}> (${modID})` },
          { name: 'Duration', value: '1d' },
          { name: 'Reason', value: 'ルール2違反: 誹謗中傷' }
        ]
      }]
    }

    const parsed = wickModeration.parseWickLogMessage(wickMsg, { channelID: 'C_WICK' })
    assert.ok(parsed)
    assert.equal(parsed.action, 'Timeout')
    assert.equal(parsed.caseID, '42')
    assert.equal(parsed.targetUserID, targetID)
    assert.equal(parsed.duration, '1d')
    assert.equal(parsed.reason, 'ルール2違反: 誹謗中傷')
    assert.equal(wickModeration.entryMatchesTarget(parsed, targetID), true)
    // Critical: moderator who issued the timeout must NOT match as the punished target!
    assert.equal(wickModeration.entryMatchesTarget(parsed, modID), false)

    // Non-Wick messages return null
    const humanMsg = { id: '9002', author: { id: '333', username: 'Alice', bot: false }, content: 'Ban | Case #1' }
    assert.equal(wickModeration.parseWickLogMessage(humanMsg), null)
  })

  test('onWickMessage remembers Wick channel, caches case, and syncs Quarantine without downgrading banned status', async () => {
    const targetID = '444444444444444444'
    const marked = []
    altDB.isAltDetectionEnabled = async () => true
    altDB.getMemberProfile = async () => ({ userID: targetID, status: 'active' })
    altDB.markMemberStatus = async (guildID, userID, status, opts) => {
      marked.push({ guildID, userID, status, reason: opts.reason })
    }

    const guild = { id: 'G1', members: new Map() }
    const msg = {
      id: '9100',
      timestamp: Date.parse('2026-11-25T10:00:00Z'),
      channel: { id: 'C_CUSTOM_LOG', guild },
      author: { id: wickModeration.WICK_BOT_ID, username: 'Wick', bot: true },
      embeds: [{
        title: 'Quarantine | Case #88',
        description: `User: <@${targetID}>\nReason: レイド疑い`
      }]
    }

    const parsed = await wickModeration.onWickMessage(msg)
    assert.equal(parsed.action, 'Quarantine')
    assert.equal(marked.length, 1)
    assert.equal(marked[0].status, 'restricted')
    assert.match(marked[0].reason, /Wick Quarantine #88.*レイド疑い/)

    // Now test that an already-banned profile is NOT downgraded to restricted
    altDB.getMemberProfile = async () => ({ userID: targetID, status: 'banned' })
    await wickModeration.onWickMessage({ ...msg, id: '9101' })
    assert.equal(marked[1].status, 'banned')
  })

  test('fetchServerRules reads guild.rulesChannelID in chronological order including embeds and respects permissions', async () => {
    const rulesCh = makeChannel({
      id: 'C_RULES',
      name: 'サーバールール',
      permsByUser: { BOT1: ['viewChannel', 'readMessageHistory'], U_NORMAL: ['viewChannel', 'readMessageHistory'] }
    })
    const secretRulesCh = makeChannel({
      id: 'C_MOD_RULES',
      name: 'mod-rules',
      permsByUser: { BOT1: ['viewChannel', 'readMessageHistory'], U_NORMAL: [] }
    })
    const guild = {
      id: 'G1',
      ownerID: 'OWNER1',
      rulesChannelID: 'C_RULES',
      channels: new Map([[rulesCh.id, rulesCh], [secretRulesCh.id, secretRulesCh]])
    }
    global.bot.getMessages = async chID => {
      if (chID === 'C_RULES') {
        // Discord returns newest-first; fetchServerRules should reverse to oldest-first
        return [
          { id: '2', content: '', embeds: [{ title: '第2条', description: 'スパム・荒らし行為の禁止' }] },
          { id: '1', content: '第1条: 他者への誹謗中傷を禁止します', embeds: [] }
        ]
      }
      if (chID === 'C_MOD_RULES') {
        return [{ id: '3', content: '極秘モデレーター内規', embeds: [] }]
      }
      return []
    }

    const normalUser = { id: 'U_NORMAL', permissions: makePerms([]), roles: [] }
    const rules = await wickModeration.fetchServerRules(guild, { requester: normalUser })
    assert.equal(rules.channels.length, 1)
    assert.equal(rules.channels[0].id, 'C_RULES')
    assert.ok(rules.text.indexOf('第1条') < rules.text.indexOf('第2条'), 'rules should be in chronological order')
    assert.match(rules.text, /スパム・荒らし行為の禁止/)
    assert.doesNotMatch(rules.text, /極秘モデレーター内規/)
  })

  test('buildModerationDossier combines Wick logs, audit logs, alt alerts, mod-deleted messages, and Wick templates', async () => {
    const targetID = '555555555555555555'
    const wickLogCh = makeChannel({ id: 'C_WICK', name: 'wick-logs' })
    const genCh = makeChannel({ id: 'C_GEN', name: '雑談' })
    const guild = {
      id: 'G1',
      ownerID: 'OWNER1',
      channels: new Map([[wickLogCh.id, wickLogCh], [genCh.id, genCh]]),
      roles: new Map([['R_OFF', { id: 'R_OFF', name: '制限ロール', position: 1 }]]),
      members: new Map([
        [wickModeration.WICK_BOT_ID, { id: wickModeration.WICK_BOT_ID, username: 'Wick', bot: true }],
        [targetID, { id: targetID, username: 'troll_kun', nick: 'あらし', roles: ['R_OFF'], joinedAt: Date.parse('2026-11-24T00:00:00Z') }]
      ]),
      getAuditLog: async () => ({
        entries: [{
          id: '1300000000000000000',
          actionType: 72,
          targetID,
          count: 3,
          user: { id: 'MOD1', username: 'ModAlice', bot: false }
        }, {
          id: '1300000000000000001',
          actionType: 24,
          targetID,
          user: { id: wickModeration.WICK_BOT_ID, username: 'Wick', bot: true },
          after: { communication_disabled_until: '2026-11-25T15:00:00Z' },
          reason: '連投スパム'
        }]
      })
    }

    global.bot.getMessages = async chID => {
      if (chID === 'C_WICK') {
        return [{
          id: 'W1',
          timestamp: Date.parse('2026-11-25T09:00:00Z'),
          author: { id: wickModeration.WICK_BOT_ID, username: 'Wick', bot: true },
          embeds: [{
            title: 'Warn | Case #15',
            fields: [
              { name: 'User', value: `<@${targetID}>` },
              { name: 'Moderator', value: '<@MOD1>' },
              { name: 'Reason', value: 'ルール1違反: 暴言' }
            ]
          }]
        }]
      }
      return []
    }

    altDB.getCandidateProfiles = async () => []
    altDB.getMemberProfile = async () => ({
      userID: targetID,
      username: 'troll_kun',
      status: 'restricted',
      statusAt: new Date('2026-11-25T09:30:00Z'),
      moderationReason: '要注意ロール付与'
    })
    altDB.getMemberMessages = async () => [
      { id: 'M1', channelID: 'C_GEN', content: 'しね連投メッセージ', ts: new Date('2026-11-25T09:10:00Z'), deleted: true, deletedBy: 'moderator' },
      { id: 'M2', channelID: 'C_GEN', content: '普通のメッセージ', ts: new Date('2026-11-25T09:05:00Z'), deleted: false }
    ]
    altDB.getRecentAlerts = async () => [{
      suspectUserID: targetID,
      candidateUserID: '666666666666666666',
      candidateUsername: 'banned_main',
      candidateStatus: 'banned',
      verdict: 'likely_alt',
      aiConfidence: 91,
      heuristicScore: 78,
      summary: '文体と活動時間帯が一致',
      createdAt: new Date('2026-11-25T09:20:00Z')
    }]

    const dossier = await wickModeration.buildModerationDossier(guild, `<@${targetID}>`)
    assert.match(dossier, /ユーザーID: `555555555555555555`/)
    assert.match(dossier, /Wick Bot 導入状況: サーバーに導入済み/)
    assert.match(dossier, /Warn \/ Case #15 \/ 理由: ルール1違反: 暴言/)
    assert.match(dossier, /実行: Wick Bot/)
    assert.match(dossier, /モデレーターによるメッセージ削除（3件）/)
    assert.match(dossier, /likely_alt.*banned_main/)
    assert.match(dossier, /\[モデレーター削除済み\] しね連投メッセージ/)
    assert.match(dossier, /\/ban add user:555555555555555555 reason:/)
    assert.match(dossier, /\/timeout add user:555555555555555555 duration:1h reason:/)
    assert.match(dossier, /\/cases view user:555555555555555555/)
  })

  test('eventTools gates get_moderation_dossier strictly to moderators while allowing get_server_rules', async () => {
    const rulesCh = makeChannel({ id: 'C_RULES', name: 'rules' })
    const guild = {
      id: 'G1',
      ownerID: 'OWNER1',
      rulesChannelID: 'C_RULES',
      channels: new Map([[rulesCh.id, rulesCh]]),
      roles: new Map(),
      members: new Map()
    }
    global.bot.getMessages = async () => [{ id: 'R1', content: 'ルール1: 仲良くする', embeds: [] }]

    const regularMember = { id: 'USER1', permissions: makePerms([]), roles: [] }
    const modMember = { id: 'MOD1', permissions: makePerms(['manageMessages']), roles: [] }

    const userTools = createTools({ guild, member: regularMember, ask: async () => '' })
    const userToolNames = userTools.declarations.map(d => d.name)
    assert.ok(userToolNames.includes('get_server_rules'))
    assert.ok(!userToolNames.includes('get_moderation_dossier'), 'non-moderators must not see get_moderation_dossier')

    const denied = await userTools.call('get_moderation_dossier', { member: '555555555555555555' })
    assert.match(denied.error, /モデレーター以上の権限が必要/)

    const rulesRes = await userTools.call('get_server_rules', {})
    assert.match(rulesRes.result, /ルール1: 仲良くする/)

    const modTools = createTools({ guild, member: modMember, ask: async () => '' })
    assert.ok(modTools.declarations.map(d => d.name).includes('get_moderation_dossier'))
  })

  test('altDetector.buildAlertEmbed includes copy-pasteable Wick V5 slash command for high-risk alerts', () => {
    const embed = altDetector.buildAlertEmbed({
      suspectProfile: { userID: '777777777777777777', username: 'new_alt', status: 'active' },
      candidateProfile: { userID: '888888888888888888', username: 'banned_old', status: 'banned' },
      heuristic: { score: 80, signals: ['招待コード一致'], counterSignals: [] },
      ai: { verdict: 'likely_alt', confidence: 92, summary: 'BAN回避の可能性が高い', matchingEvidence: ['文体一致'], counterEvidence: [] },
      trigger: 'join',
      lang: 'ja'
    })
    const wickField = embed.fields.find(f => f.name.includes('Wick'))
    assert.ok(wickField, 'expected Wick command field on high-risk alt alert')
    assert.match(wickField.value, /\/ban add user:777777777777777777 reason:BAN回避・サブ垢の疑い/)
    assert.match(wickField.value, /\/cases view user:777777777777777777/)
  })
})
