// Logging starts the moment the bot joins a server: it makes a log channel only the server's staff
// can see (#robopolice-logs: hidden from @everyone; administrators see every channel) and logs every
// event there, as if `/setup` had been run in it with everything chosen. The staff change it with
// `/setup`, `/stoplogging` and `/ignorechannel` as usual. A server that already logs something (it
// was joined before) is left as it is. Needs Manage Channels and Manage Webhooks; without them
// nothing is made and the server is set up by hand. AUTO_LOG_CHANNEL=false turns it off.
const { ALL_EVENTS } = require('../utils/constants')
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

// Resolves to the channel every event now logs to, or null when nothing was done.
async function startLogging (guild) {
  if (!enabled() || logsSomething(guild.id)) return null
  const me = guild.members.get(global.bot.user.id)
  if (!me?.permissions.has('manageChannels') || !me.permissions.has('manageWebhooks')) {
    global.logger.info(`[AUTO LOG]: ${guild.id} did not give Manage Channels and Manage Webhooks; set up by hand`)
    return null
  }
  let channel = [...guild.channels.values()].find(c => c.type === 0 && c.name === CHANNEL_NAME)
  if (!channel) {
    channel = await global.bot.createChannel(guild.id, CHANNEL_NAME, 0, {
      reason: 'RoboPolice: log channel for the server staff',
      topic: 'ロボポリスのログ（スタッフ用）。/setup で記録するものを変え、/stoplogging で止められます。',
      permissionOverwrites: [
        { id: guild.id, type: 0, allow: '0', deny: String(P.viewChannel) },
        { id: global.bot.user.id, type: 1, allow: String(BOT_ALLOW), deny: '0' }
      ]
    })
  }
  await update.setEventsLogId(guild.id, channel.id, ALL_EVENTS)
  global.logger.info(`[AUTO LOG]: ${guild.id} logs every event to ${channel.id}`)
  await global.bot.createMessage(channel.id, {
    content: [
      '**ロボポリスのログを開始しました。** このチャンネルに、すべてのイベント（参加・退出、BAN・キック、メッセージの編集・削除、ロール・チャンネル・サーバー設定の変更、ボイスなど）を記録します。',
      'このチャンネルは `@everyone` から見えないようにしてあります（管理者には見えます）。スタッフにも見せるときは、チャンネルの権限でロールを追加してください。',
      '記録するものは `/setup`、対象外にするチャンネルは `/ignorechannel`、止めるときは `/stoplogging` で変えられます。'
    ].join('\n')
  }).catch(() => {})
  return channel
}

module.exports = { startLogging, enabled, CHANNEL_NAME }
