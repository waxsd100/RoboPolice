// Logging starts the moment the bot joins a server: it makes a log channel only the server's staff
// can see (#robopolice-logs: hidden from @everyone; administrators see every channel) and logs every
// event there, as if `/setup` had been run in it with everything chosen. The staff change it with
// `/setup`, `/stoplogging` and `/ignorechannel` as usual. A server that already logs something (it
// was joined before) is left as it is. Needs Manage Channels and Manage Webhooks; without them
// nothing is made and the server is set up by hand (with a hint in the system channel if writable).
// AUTO_LOG_CHANNEL=false turns it off.
const { ALL_EVENTS, EMBED_COLORS } = require('../utils/constants')
const { formatPermissions } = require('../utils/displayLabels')
const update = require('../../db/interfaces/postgres/update')

const CHANNEL_NAME = 'robopolice-logs'
const P = { viewChannel: 1n << 10n, sendMessages: 1n << 11n, embedLinks: 1n << 14n, attachFiles: 1n << 15n, readMessageHistory: 1n << 16n, manageWebhooks: 1n << 29n }
const BOT_ALLOW = P.viewChannel | P.sendMessages | P.embedLinks | P.attachFiles | P.readMessageHistory | P.manageWebhooks

function enabled () {
  return process.env.AUTO_LOG_CHANNEL !== 'false'
}

const logsSomething = guildID => {
  const raw = global.bot.guildSettingsCache[guildID]?.getEventLogRaw?.() || {}
  return Object.values(raw).some(Boolean)
}

function buildPermissionChecklist (me) {
  const hasAudit = Boolean(me?.permissions?.has?.('viewAuditLog'))
  const hasInviteTracking = Boolean(me?.permissions?.has?.('manageGuild') && me?.permissions?.has?.('manageChannels'))
  const hasEvents = Boolean(me?.permissions?.has?.('manageEvents'))
  return [
    `${hasAudit ? '✅' : '⚠️'} **監査ログの取得**: ${hasAudit ? '有効（実行者や理由を記録できます）' : '「**監査ログの表示**」権限を付与すると、BANや変更の実行者も記録できます'}`,
    `${hasInviteTracking ? '✅' : '💡'} **参加ログの招待リンク追跡**: ${hasInviteTracking ? '有効' : '使う場合は「**サーバーの管理**」権限を追加してください（`/invite` 参照）'}`,
    `${hasEvents ? '✅' : '💡'} **イベント作成・配信自動登録**: ${hasEvents ? '有効' : '使う場合は「**イベントの管理**」権限を追加してください'}`
  ].join('\n')
}

function buildOnboardingEmbed (channel, me) {
  return {
    title: '🚀 ロボポリス 初期設定ガイド',
    color: EMBED_COLORS.GREEN,
    description: `このチャンネル（<#${channel.id}>）は \`@everyone\` から非表示のスタッフ専用チャンネルとして自動作成され、全 **${ALL_EVENTS.length} 種類**の監査ログが有効になっています。管理者以外のスタッフにも見せる場合は、チャンネルの権限設定でロールを追加してください。`,
    fields: [
      {
        name: '📋 監査ログの調整',
        value: [
          '・`/setup status` — 現在の設定状況と必要な権限をまとめて確認・操作',
          '・`/setup via_presets` — 出力するログをカテゴリ単位で変更',
          '・`/ignorechannel` — 特定のチャンネルをログ対象から除外',
          '・`/stoplogging` — ログ出力の停止'
        ].join('\n')
      },
      {
        name: '🤖 AIアシスタント（@メンション）',
        value: [
          '・どのチャンネルでも BOT に `@メンション` すると、会話・質問応答、**予定イベントの作成**、**フォーラム投稿の作成**が使えます',
          '・`/setup assistant` — 話し方（配信者／BOT）・返事の長さ・YouTube配信の自動イベント登録を設定',
          '・`/assistantrules` — AI に守ってほしいサーバー独自のルール・注意事項を設定'
        ].join('\n')
      },
      {
        name: '🔐 BOT 権限の診断',
        value: buildPermissionChecklist(me)
      }
    ]
  }
}

async function notifyManualSetupIfPossible (guild, me) {
  if (!guild?.systemChannelID) return
  const sysChannel = guild.channels?.get?.(guild.systemChannelID)
  if (!sysChannel) return
  const perms = sysChannel.permissionsOf?.(global.bot.user.id)?.json
  const canSend = perms ? (perms.viewChannel && perms.sendMessages) : Boolean(me?.permissions?.has?.('viewChannel') && me?.permissions?.has?.('sendMessages'))
  if (!canSend) return
  const missing = ['manageChannels', 'manageWebhooks'].filter(p => !me?.permissions?.has?.(p))
  await global.bot.createMessage(sysChannel.id, {
    embeds: [{
      title: '🛠️ ロボポリスを導入いただきありがとうございます',
      color: EMBED_COLORS.YELLOW_ORANGE,
      description: [
        `BOT に ${formatPermissions(missing, 'ja')} 権限がないため、スタッフ用ログチャンネル（\`#${CHANNEL_NAME}\`）の自動作成はスキップされました。`,
        '',
        '**初期設定の進め方:**',
        '1. ログを出力したいテキストチャンネルで **`/setup status`** を実行すると、必要な権限の診断と設定メニューが開きます（推奨権限つきの再招待リンクは `/invite` で確認できます）。',
        '2. AI（`@メンション`）の話し方や返事の長さは **`/setup assistant`** でいつでも変更できます。'
      ].join('\n')
    }]
  }).catch(() => {})
}

// Resolves to the channel every event now logs to, or null when nothing was done.
async function startLogging (guild) {
  if (!enabled() || logsSomething(guild.id)) return null
  const me = guild.members.get(global.bot.user.id)
  if (!me?.permissions.has('manageChannels') || !me.permissions.has('manageWebhooks')) {
    global.logger.info(`[AUTO LOG]: ${guild.id} did not give Manage Channels and Manage Webhooks; set up by hand`)
    await notifyManualSetupIfPossible(guild, me)
    return null
  }
  let channel = [...guild.channels.values()].find(c => c.type === 0 && c.name === CHANNEL_NAME)
  if (!channel) {
    channel = await global.bot.createChannel(guild.id, CHANNEL_NAME, 0, {
      reason: 'RoboPolice: log channel for the server staff',
      topic: 'ロボポリスのログ（スタッフ用）。/setup status で設定確認、/stoplogging で停止できます。',
      permissionOverwrites: [
        { id: guild.id, type: 0, allow: '0', deny: String(P.viewChannel) },
        { id: global.bot.user.id, type: 1, allow: String(BOT_ALLOW), deny: '0' }
      ]
    })
  }
  await update.setEventsLogId(guild.id, channel.id, ALL_EVENTS)
  global.logger.info(`[AUTO LOG]: ${guild.id} logs every event to ${channel.id}`)
  await global.bot.createMessage(channel.id, {
    content: '**✅ ロボポリスのログを開始しました。** 下のガイドから必要に応じて設定を調整できます。',
    embeds: [buildOnboardingEmbed(channel, me)]
  }).catch(() => {})
  return channel
}

module.exports = { startLogging, enabled, CHANNEL_NAME, buildOnboardingEmbed, buildPermissionChecklist }
