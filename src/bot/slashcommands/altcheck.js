const Eris = require('eris')
const altDetector = require('../modules/altDetector')
const altDB = require('../../db/interfaces/postgres/altDetection')
const { EMBED_COLORS } = require('../utils/constants')
const { getEmbedFooter } = require('../utils/embeds')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { langOf, pick } = require('../utils/i18n')

const EPHEMERAL = Eris.Constants.MessageFlags.EPHEMERAL

function parseUserID (raw) {
  if (!raw) return null
  const match = String(raw).trim().match(/^(?:<@!?)?(\d{15,22})>?$/)
  return match ? match[1] : null
}

function getSubcommand (interaction) {
  const opts = interaction.data?.options || []
  const sub = opts.find(o => o.type === Eris.Constants.ApplicationCommandOptionTypes.SUB_COMMAND || Array.isArray(o.options))
  return sub || null
}

function getOption (sub, name) {
  return sub?.options?.find(o => o.name === name)?.value
}

async function sendReply (interaction, payload, deferred) {
  if (deferred && typeof interaction.editOriginalMessage === 'function') {
    return interaction.editOriginalMessage(payload).catch(() => {})
  }
  return interaction.createMessage({ ...payload, flags: EPHEMERAL }).catch(() => {})
}

function clamp (str, max) {
  const s = String(str ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

function formatCandidateSummary (item, rank, lang) {
  const p = item.candidateProfile
  const status = lang === 'en' ? altDetector.statusLabelEn(p.status) : altDetector.statusLabelJa(p.status)
  const name = p.username ? `**${p.username}**` : (lang === 'en' ? 'Unknown' : '不明')
  const topSignals = item.heuristic.signals.slice(0, 2).join(' / ')
  const counter = item.heuristic.counterSignals[0] ? ` ⚠️ ${item.heuristic.counterSignals[0]}` : ''
  const scorePart = lang === 'en' ? `Score ${item.heuristic.score}/100` : `スコア ${item.heuristic.score}/100`
  return `${rank}. <@${p.userID}> (${name}・${status}) — **${scorePart}**${topSignals ? `\n   └ ${topSignals}` : ''}${counter ? `\n   └${counter}` : ''}`
}

async function handleFind (interaction, guild, sub) {
  const lang = langOf(interaction)
  const rawUser = getOption(sub, 'user') || getOption(sub, 'user_id')
  const userID = parseUserID(rawUser)
  if (!userID) {
    return interaction.createMessage({
      content: pick(interaction, {
        ja: '調査するユーザーを `user` で指定してください（BAN済みアカウントはユーザーIDをそのまま入力できます）。',
        en: 'Please specify a target user with `user` (you can paste a raw user ID for banned accounts).'
      }),
      flags: EPHEMERAL
    }).catch(() => {})
  }

  let deferred = false
  if (typeof interaction.defer === 'function') {
    await interaction.defer(EPHEMERAL).catch(() => {})
    deferred = true
  }

  const res = await altDetector.investigateUser(guild, userID)
  const fields = [{
    name: lang === 'en' ? 'Target account' : '調査対象アカウント',
    value: clamp(`${altDetector.formatUserLine(res.suspectProfile, lang)}\n${lang === 'en' ? `Stored messages analyzed: ${res.suspectMessageCount}` : `分析対象の保存メッセージ数: ${res.suspectMessageCount} 件`}`, 1024)
  }]

  if (!res.candidates.length || res.topCandidate.heuristic.score === 0) {
    const embed = {
      title: lang === 'en' ? '🔍 Alt-Account Search Result' : '🔍 サブ垢候補の調査結果',
      color: EMBED_COLORS.GREEN,
      description: lang === 'en'
        ? 'No suspicious matching accounts were found among recorded banned/kicked/left or active members.'
        : '記録されている BAN・キック・退出済みアカウントおよび既存メンバーの中に、一致度の高いサブ垢候補は見つかりませんでした。',
      fields,
      footer: getEmbedFooter(global.bot.user),
      timestamp: new Date()
    }
    return sendReply(interaction, { embeds: [embed] }, deferred)
  }

  const top = res.topCandidate
  const ai = res.ai
  const color = ai?.verdict === 'likely_alt'
    ? EMBED_COLORS.RED
    : (ai?.verdict === 'possible_alt' || top.heuristic.score >= 50 ? EMBED_COLORS.YELLOW_ORANGE : EMBED_COLORS.PURPLED_BLUE)

  fields.push({
    name: lang === 'en' ? 'Top matching candidates (Stage 1)' : '一致候補ランキング（第1段階スコア）',
    value: clamp(res.candidates.map((c, idx) => formatCandidateSummary(c, idx + 1, lang)).join('\n'), 1024)
  })

  if (ai) {
    fields.push({
      name: lang === 'en' ? `AI Precision Review (Top #1: <@${top.candidateProfile.userID}>)` : 'AI 精密判定（1位候補との比較）',
      value: clamp([
        `${altDetector.verdictLabel(ai.verdict, lang)}（${lang === 'en' ? 'Confidence' : '確信度'}: **${ai.confidence}%**）`,
        ai.summary || '',
        ...(ai.matchingEvidence.length ? [lang === 'en' ? '**Evidence:**' : '**根拠:**', ...ai.matchingEvidence.map(e => `・${e}`)] : []),
        ...(ai.counterEvidence.length ? [lang === 'en' ? '**Caveats:**' : '**反証・注意点:**', ...ai.counterEvidence.map(e => `・${e}`)] : [])
      ].filter(Boolean).join('\n'), 1024)
    })
  } else if (!isGatewayConfigured()) {
    fields.push({
      name: lang === 'en' ? 'AI Precision Review' : 'AI 精密判定',
      value: lang === 'en'
        ? 'Skipped (Gemini API is not configured — showing Stage 1 heuristic results only).'
        : 'Gemini API が未設定のためスキップしました（第1段階のルール・文体スコアのみ表示）。'
    })
  }

  const embed = {
    title: lang === 'en' ? '🔍 Alt-Account Search Result' : '🔍 サブ垢候補の調査結果',
    color,
    description: lang === 'en'
      ? 'To inspect any pair in detail, run `/altcheck compare user1:<A> user2:<B>`.'
      : '特定の2アカウントを詳しく比較するには `/altcheck compare` を実行してください（自動処罰は行いません）。',
    fields,
    footer: getEmbedFooter(global.bot.user),
    timestamp: new Date()
  }
  return sendReply(interaction, { embeds: [embed] }, deferred)
}

async function handleScan (interaction, guild, sub) {
  const lang = langOf(interaction)
  const scope = getOption(sub, 'scope') || 'all'
  const rawLimit = Number(getOption(sub, 'limit'))
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 10 ? rawLimit : 5

  let deferred = false
  if (typeof interaction.defer === 'function') {
    await interaction.defer(EPHEMERAL).catch(() => {})
    deferred = true
  }

  const res = await altDetector.scanServer(guild, { scope, limit, aiVerifyTop: 2 })
  const scopeLabel = lang === 'en'
    ? ({ all: 'All (BAN/kick evasion + existing members)', ban_evasion: 'BAN/kick/leave evasion', members: 'Existing members' }[scope] || scope)
    : ({ all: 'すべて（BAN/キック回避＋既存メンバー同士）', ban_evasion: 'BAN・キック・退出アカウントとの照合', members: '既存メンバー同士の同一人物チェック' }[scope] || scope)

  if (!res.pairs.length) {
    const embed = {
      title: lang === 'en' ? '🔎 Server Alt-Account Scan' : '🔎 サーバー内サブ垢スキャン結果',
      color: EMBED_COLORS.GREEN,
      description: lang === 'en'
        ? `Scanned **${res.scannedProfiles}** profiles (${res.scannedActive} active, ${res.scannedFormer} former) and **${res.scannedActivePosters}** recent posters.\nNo suspicious alt-account pairs exceeded the threshold.`
        : `**${res.scannedProfiles} 件**のプロフィール（在籍 ${res.scannedActive} ／ BAN・キック・退出 ${res.scannedFormer}）および最近の発言者 **${res.scannedActivePosters} 人**をスキャンしました。\nしきい値を超えるサブ垢候補ペアは見つかりませんでした。`,
      fields: [{ name: lang === 'en' ? 'Scope' : 'スキャン対象', value: scopeLabel }],
      footer: getEmbedFooter(global.bot.user),
      timestamp: new Date()
    }
    return sendReply(interaction, { embeds: [embed] }, deferred)
  }

  const hasLikely = res.pairs.some(p => p.ai?.verdict === 'likely_alt')
  const hasPossible = res.pairs.some(p => p.ai?.verdict === 'possible_alt' || p.heuristic.score >= 50)
  const color = hasLikely ? EMBED_COLORS.RED : (hasPossible ? EMBED_COLORS.YELLOW_ORANGE : EMBED_COLORS.PURPLED_BLUE)

  const fields = res.pairs.map((pair, idx) => {
    const a = pair.suspectProfile
    const b = pair.candidateProfile
    const statusB = lang === 'en' ? altDetector.statusLabelEn(b.status) : altDetector.statusLabelJa(b.status)
    const lines = [
      `<@${a.userID}> (${a.username || '?'}) ⇄ <@${b.userID}> (${b.username || '?'}・${statusB})`,
      lang === 'en'
        ? `Stage 1 Score: **${pair.heuristic.score}/100**`
        : `第1段階スコア: **${pair.heuristic.score}/100**`
    ]
    if (pair.ai) {
      lines.push(`${altDetector.verdictLabel(pair.ai.verdict, lang)}（${lang === 'en' ? 'AI' : 'AI確信度'}: **${pair.ai.confidence}%**）`)
      if (pair.ai.summary) lines.push(pair.ai.summary)
    } else if (pair.heuristic.signals.length) {
      lines.push(...pair.heuristic.signals.slice(0, 3).map(s => `・${s}`))
    }
    if (pair.heuristic.counterSignals.length) {
      lines.push(`⚠️ ${pair.heuristic.counterSignals[0]}`)
    }
    return {
      name: lang === 'en' ? `#${idx + 1} Candidate Pair` : `候補ペア #${idx + 1}`,
      value: clamp(lines.join('\n'), 1024)
    }
  })

  const embed = {
    title: lang === 'en' ? '🔎 Server Alt-Account Scan' : '🔎 サーバー内サブ垢スキャン結果',
    color,
    description: lang === 'en'
      ? `Scope: **${scopeLabel}**\nScanned **${res.scannedProfiles}** profiles & **${res.scannedActivePosters}** recent posters. Top ${Math.min(2, res.pairs.length)} suspicious pair(s) were precision-reviewed by AI.\nRun \`/altcheck compare\` for a full breakdown of any pair.`
      : `対象: **${scopeLabel}**\n**${res.scannedProfiles} 件**のプロフィールと最近の発言者 **${res.scannedActivePosters} 人**をスキャンし、上位候補を AI で精密判定しました。\n気になるペアは \`/altcheck compare\` で詳細比較できます（自動処罰は行いません）。`,
    fields,
    footer: getEmbedFooter(global.bot.user),
    timestamp: new Date()
  }
  return sendReply(interaction, { embeds: [embed] }, deferred)
}

async function handleCompare (interaction, guild, sub) {
  const lang = langOf(interaction)
  const id1 = parseUserID(getOption(sub, 'user1'))
  const id2 = parseUserID(getOption(sub, 'user2'))
  if (!id1 || !id2) {
    return interaction.createMessage({
      content: pick(interaction, {
        ja: '`user1` と `user2` に比較する2人のユーザーを指定してください（BAN済みアカウントはユーザーIDをそのまま入力できます）。',
        en: 'Please provide both `user1` and `user2` (raw user IDs work for banned accounts too).'
      }),
      flags: EPHEMERAL
    }).catch(() => {})
  }
  if (id1 === id2) {
    return interaction.createMessage({
      content: pick(interaction, {
        ja: '同じアカウント同士は比較できません。異なる2つのアカウントを指定してください。',
        en: 'Cannot compare an account with itself. Please choose two different accounts.'
      }),
      flags: EPHEMERAL
    }).catch(() => {})
  }

  let deferred = false
  if (typeof interaction.defer === 'function') {
    await interaction.defer(EPHEMERAL).catch(() => {})
    deferred = true
  }

  const res = await altDetector.compareUsers(guild, id1, id2)
  const embed = altDetector.buildAlertEmbed({
    suspectProfile: res.suspectProfile,
    candidateProfile: res.candidateProfile,
    heuristic: res.heuristic,
    ai: res.ai,
    trigger: 'manual',
    lang
  })
  embed.title = lang === 'en' ? '⚖️ Alt-Account Comparison Result' : '⚖️ サブ垢比較・同一人物判定結果'
  embed.description = lang === 'en'
    ? `Compared **${res.suspectMessageCount}** stored message(s) of A vs **${res.candidateMessageCount}** stored message(s) of B. Results are advisory for staff review.`
    : `アカウント A（保存発言 ${res.suspectMessageCount} 件）とアカウント B（保存発言 ${res.candidateMessageCount} 件）を比較しました。スタッフ確認用の参考情報です（自動処罰なし）。`
  embed.footer = getEmbedFooter(global.bot.user)
  return sendReply(interaction, { embeds: [embed] }, deferred)
}

async function handleConfig (interaction, guild, sub) {
  const lang = langOf(interaction)
  const enabledOpt = getOption(sub, 'enabled')
  let enabled
  if (typeof enabledOpt === 'boolean') {
    enabled = await altDB.setAltDetection(guild.id, enabledOpt)
  } else {
    enabled = await altDB.isAltDetectionEnabled(guild.id)
  }

  const guildSettings = global.bot?.guildSettingsCache?.[guild.id]
  const alertEvent = altDetector.pickAlertEventName(guildSettings)
  const alertChannelId = alertEvent ? guildSettings?.getEventByName?.(alertEvent) : null
  const globalOff = !altDetector.isGlobalEnabled()

  const statusText = enabled
    ? (lang === 'en' ? '✅ **Enabled**' : '✅ **有効（オン）**')
    : (lang === 'en' ? '⬜ **Disabled**' : '⬜ **無効（オフ）**')

  const lines = [
    lang === 'en' ? `Automatic alt-account detection: ${statusText}` : `自動サブ垢検知: ${statusText}`,
    lang === 'en'
      ? `Alert destination: ${alertChannelId ? `<#${alertChannelId}>` : '⚠️ No log channel configured (run `/setup via_presets` first)'}`
      : `アラート通知先: ${alertChannelId ? `<#${alertChannelId}>` : '⚠️ ログチャンネル未設定（先に `/setup via_presets` を実行してください）'}`,
    lang === 'en'
      ? `AI precision review: ${isGatewayConfigured() ? 'Available (2-stage hybrid)' : 'Unavailable (heuristic-only fallback)'}`
      : `AI 精密判定: ${isGatewayConfigured() ? '利用可能（第1段階ルール＋第2段階Geminiのハイブリッド方式）' : '未接続（ルール判定フォールバックのみ）'}`,
    lang === 'en'
      ? 'Action on detection: **Alert only to staff log channel** (no automatic ban/kick/timeout).'
      : '検知時の動作: **スタッフ向けログチャンネルへのアラート通知のみ**（自動BAN/キックなし）'
  ]
  if (globalOff) {
    lines.push(lang === 'en'
      ? '⚠️ Global environment variable `ALT_DETECTION=false` is set by the bot operator.'
      : '⚠️ BOT 運営側で環境変数 `ALT_DETECTION=false` が設定されているため、自動検知は一時停止中です。')
  }

  const embed = {
    title: lang === 'en' ? '🛡️ Alt-Account Detection Settings' : '🛡️ AI サブ垢検知の設定',
    color: enabled ? EMBED_COLORS.GREEN : EMBED_COLORS.PURPLED_BLUE,
    description: lines.join('\n'),
    fields: [{
      name: lang === 'en' ? 'Available Commands' : '使えるコマンド',
      value: lang === 'en'
        ? [
            '・`/altcheck find user:<target>` — Search for alt candidates for a user',
            '・`/altcheck scan` — Scan the server for suspicious alt pairs',
            '・`/altcheck compare user1:<A> user2:<B>` — Directly compare two accounts',
            '・`/altcheck alerts` — View recent alert history',
            '・`/altcheck config enabled:<True/False>` — Toggle automatic detection'
          ].join('\n')
        : [
            '・`/altcheck find user:<対象>` — 特定ユーザーのサブ垢候補を探す',
            '・`/altcheck scan` — サーバー全体をスキャンしてサブ垢候補ペアを探す',
            '・`/altcheck compare user1:<A> user2:<B>` — 2つのアカウントを直接比較する',
            '・`/altcheck alerts` — 最近のアラート履歴を表示する',
            '・`/altcheck config enabled:<True/False>` — 自動検知のオン／オフを切り替える'
          ].join('\n')
    }],
    footer: getEmbedFooter(global.bot.user),
    timestamp: new Date()
  }
  return interaction.createMessage({ embeds: [embed], flags: EPHEMERAL }).catch(() => {})
}

async function handleAlerts (interaction, guild, sub) {
  const lang = langOf(interaction)
  const rawLimit = Number(getOption(sub, 'limit'))
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 15 ? rawLimit : 10
  const alerts = await altDB.getRecentAlerts(guild.id, { limit })

  if (!alerts.length) {
    return interaction.createMessage({
      embeds: [{
        title: lang === 'en' ? '📜 Recent Alt-Account Alerts' : '📜 最近のサブ垢検知アラート',
        color: EMBED_COLORS.PURPLED_BLUE,
        description: lang === 'en'
          ? 'No alt-account alerts have been recorded in this server yet.'
          : 'このサーバーではまだサブ垢検知アラートの履歴がありません。',
        footer: getEmbedFooter(global.bot.user)
      }],
      flags: EPHEMERAL
    }).catch(() => {})
  }

  const lines = alerts.map(a => {
    const ts = a.createdAt ? `<t:${Math.floor(a.createdAt.getTime() / 1000)}:R>` : ''
    const conf = a.aiConfidence != null ? `AI ${a.aiConfidence}% / ` : ''
    const summary = a.summary ? `\n   └ ${clamp(a.summary, 120)}` : ''
    return `• ${ts} ${altDetector.verdictLabel(a.verdict, lang)} (${conf}H:${a.heuristicScore})\n   <@${a.suspectUserID}> ⇄ <@${a.candidateUserID}> [${altDetector.triggerLabel(a.trigger, lang)}]${summary}`
  })

  return interaction.createMessage({
    embeds: [{
      title: lang === 'en' ? `📜 Recent Alt-Account Alerts (${alerts.length})` : `📜 最近のサブ垢検知アラート（直近 ${alerts.length} 件）`,
      color: EMBED_COLORS.YELLOW_ORANGE,
      description: clamp(lines.join('\n\n'), 4000),
      footer: getEmbedFooter(global.bot.user),
      timestamp: new Date()
    }],
    flags: EPHEMERAL
  }).catch(() => {})
}

module.exports = {
  name: 'altcheck',
  userPerms: ['banMembers'],
  subcommandPerms: {
    config: { userPerms: ['manageGuild'] }
  },
  parseUserID,
  func: async interaction => {
    const guild = global.bot?.guilds?.get?.(interaction.guildID)
    if (!guild) {
      return interaction.createMessage({
        content: pick(interaction, {
          ja: 'サーバー情報を取得できませんでした。少し待ってから再度お試しください。',
          en: 'Could not load server information. Please try again shortly.'
        }),
        flags: EPHEMERAL
      }).catch(() => {})
    }
    const sub = getSubcommand(interaction)
    switch (sub?.name) {
      case 'find':
        return handleFind(interaction, guild, sub)
      case 'scan':
        return handleScan(interaction, guild, sub)
      case 'compare':
        return handleCompare(interaction, guild, sub)
      case 'config':
        return handleConfig(interaction, guild, sub)
      case 'alerts':
        return handleAlerts(interaction, guild, sub)
      default:
        return handleConfig(interaction, guild, sub)
    }
  }
}
