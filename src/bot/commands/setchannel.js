const { setEventsLogId } = require('../../db/interfaces/postgres/update')
const guildWebhookCacher = require('../modules/guildWebhookCacher')
const cacheGuild = require('../utils/cacheGuild')
const eventList = require('../utils/constants').ALL_EVENTS

module.exports = {
  func: async (message, suffix = '') => {
    if (!message?.channel?.guild) return
    if (message.channel.guild.channels && typeof message.channel.guild.channels.has === 'function' && !message.channel.guild.channels.has(message.channel.id)) {
      return
    }
    if (!global.bot.guildSettingsCache?.[message.channel.guild.id]) {
      await cacheGuild(message.channel.guild.id)
    }
    const botPerms = (typeof message.channel.permissionsOf === 'function'
      ? message.channel.permissionsOf(global.bot.user.id)?.json
      : null) || {}
    if (!botPerms.manageWebhooks || !botPerms.viewAuditLog) {
      await message.channel.createMessage('setchannel の実行には「ウェブフックの管理」と「監査ログを表示」の権限が必要です。設定したログチャンネルへメッセージを送るために必須です。').catch(_ => {})
      await message.addReaction('❌').catch(_ => {})
      return
    }
    const trimmedSuffix = (suffix || '').trim()
    let events = trimmedSuffix ? trimmedSuffix.split(',').map(s => s.trim()).filter(Boolean) : []
    events = cleanArray(events)
    if (events.length === 0 && trimmedSuffix) {
      await message.channel.createMessage(`<@${message.author.id}>, none of the provided events are valid. Look at ${process.env.GLOBAL_BOT_PREFIX}help to see what is valid.`)
    } else if (events.length === 0 && !trimmedSuffix) {
      await setEventsLogId(message.channel.guild.id, message.channel.id, eventList)
      await cacheGuild(message.channel.guild.id)
      await guildWebhookCacher(message.channel.guild.id, message.channel.id)
      await message.channel.createMessage(`<@${message.author.id}>, I set all events to log here! ${!botPerms.manageChannels || !botPerms.manageGuild ? 'Invite tracking will not work until I\'m granted manage channels & manage server (I cannot get invite information without both!)' : ''}`)
    } else {
      await setEventsLogId(message.channel.guild.id, message.channel.id, events)
      await cacheGuild(message.channel.guild.id)
      await guildWebhookCacher(message.channel.guild.id, message.channel.id)
      await message.channel.createMessage(`<@${message.author.id}>, it has been done. ${events.includes('guildMemberAdd') && (!botPerms.manageChannels || !botPerms.manageGuild) ? 'Invite tracking will not work until I\'m granted manage channels & manage server (I cannot get invite information without both!)' : ''}`)
    }
  },
  name: 'setchannel',
  quickHelp: 'ログの出力先チャンネルとイベントを設定します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}setchannel\` <- 実行したチャンネルにすべてのイベントを出力
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel messageDelete, messageUpdate\` <- メッセージの削除と編集を出力
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel guildMemberAdd, guildMemberRemove, guildMemberKick\` <- 参加・退出・キックを出力 **（招待コードの記録には __チャンネルの管理とサーバー管理__ の権限が必要です。これが無いと Discord が招待情報を送信しません）**
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel anyevent\` <- イベントを個別に指定して出力。複数指定はカンマ区切り。指定できるイベント:
  \`\`\`${eventList.toString(',')}\`\`\``, // 4 characters away from max embed length
  perms: ['manageWebhooks', 'manageChannels', 'viewAuditLog'],
  noThread: true,
  category: 'Logging'
}

function cleanArray (events) {
  const tempEvents = []
  events.forEach(event => {
    const lowerInput = event.toLowerCase()
    eventList.forEach(validEvent => {
      if (validEvent.toLowerCase() === lowerInput && !tempEvents.includes(validEvent)) {
        tempEvents.push(validEvent)
      }
    })
  })
  return tempEvents
}
