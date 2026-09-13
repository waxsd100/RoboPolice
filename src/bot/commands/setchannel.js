const { setEventsLogId } = require('../../db/interfaces/postgres/update')
const guildWebhookCacher = require('../modules/guildWebhookCacher')
const cacheGuild = require('../utils/cacheGuild')

const eventList = [
  'channelCreate',
  'channelUpdate',
  'channelDelete',
  'guildBanAdd',
  'guildBanRemove',
  'guildRoleCreate',
  'guildRoleDelete',
  'guildRoleUpdate',
  'guildUpdate',
  'messageDelete',
  'messageDeleteBulk',
  'messageUpdate',
  'guildMemberAdd',
  'guildMemberKick',
  'guildMemberRemove',
  'guildMemberUpdate',
  'voiceChannelLeave',
  'voiceChannelJoin',
  'voiceStateUpdate',
  'voiceChannelSwitch',
  'guildMemberNickUpdate',
  'guildMemberVerify',
  'guildEmojisUpdate',
  'guildStickersUpdate',
  'guildMemberBoostUpdate'
]

module.exports = {
  func: async (message, suffix) => {
    const botPerms = message.channel.permissionsOf(global.bot.user.id).json
    if (!botPerms.manageWebhooks || !botPerms.viewAuditLogs) {
      message.channel.createMessage('setchannel の実行には「ウェブフックの管理」と「監査ログを表示」の権限が必要です。設定したログチャンネルへメッセージを送るために必須です。').catch(_ => {})
      message.addReaction('❌').catch(_ => {})
      return
    }
    let events = suffix.split(', ')
    events = cleanArray(events)
    if (events.length === 0 && suffix) {
      message.channel.createMessage(`<@${message.author.id}>, none of the provided events are valid. Look at ${process.env.GLOBAL_BOT_PREFIX}help to see what is valid.`)
    } else if (events.length === 0 && !suffix) {
      await setEventsLogId(message.channel.guild.id, message.channel.id, eventList)
      await cacheGuild(message.channel.guild.id)
      await guildWebhookCacher(message.channel.guild.id, message.channel.id)
      message.channel.createMessage(`<@${message.author.id}>, I set all events to log here! ${!botPerms.manageChannels || !botPerms.manageGuild ? 'Invite tracking will not work until I\'m granted manage channels & manage server (I cannot get invite information without both!)' : ''}`)
    } else {
      await setEventsLogId(message.channel.guild.id, message.channel.id, events)
      await cacheGuild(message.channel.guild.id)
      await guildWebhookCacher(message.channel.guild.id, message.channel.id)
      message.channel.createMessage(`<@${message.author.id}>, it has been done. ${events.includes('guildMemberAdd') && (!botPerms.manageChannels || !botPerms.manageGuild) ? 'Invite tracking will not work until I\'m granted manage channels & manage server (I cannot get invite information without both!)' : ''}`)
    }
  },
  name: 'setchannel',
  quickHelp: 'ログの出力先チャンネルとイベントを設定します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}setchannel\` <- 実行したチャンネルにすべてのイベントを出力
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel messageDelete, messageUpdate\` <- メッセージの削除と編集を出力
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel guildMemberAdd, guildMemberRemove, guildMemberKick\` <- 参加・退出・キックを出力 **（招待コードの記録には __チャンネルの管理とサーバー管理__ の権限が必要です。これが無いと Discord が招待情報を送信しません）**
  \`${process.env.GLOBAL_BOT_PREFIX}setchannel anyevent\` <- イベントを個別に指定して出力。複数指定はカンマ区切り。指定できるイベント:
  \`\`\`${eventList.toString(',')}\`\`\``, // 4 characters away from max embed length
  perms: ['manageWebhooks', 'manageChannels', 'viewAuditLogs'],
  noThread: true,
  category: 'Logging'
}

function cleanArray (events) {
  const tempEvents = []
  events.forEach(event => {
    if (eventList.includes(event)) {
      eventList.forEach(validEvent => {
        const lowerEvent = validEvent.toLowerCase()
        const upperEvent = validEvent.toUpperCase()
        if (event === lowerEvent || event === upperEvent || event === validEvent) {
          tempEvents.push(validEvent)
        }
      })
    }
  })
  return tempEvents
}
