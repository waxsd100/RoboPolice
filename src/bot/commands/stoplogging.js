const clearEventByID = require('../../db/interfaces/postgres/update').clearEventByID
const cacheGuild = require('../utils/cacheGuild')
const setEventLogs = require('../../db/interfaces/postgres/update').setEventsLogId
const eventList = require('../utils/constants').ALL_EVENTS

module.exports = {
  func: async (message, suffix = '') => {
    if (!message?.channel?.guild) return
    const canSend = typeof message.channel.permissionsOf === 'function'
      ? message.channel.permissionsOf(global.bot.user.id)?.json?.sendMessages
      : message.channel.guild.members?.get?.(global.bot.user.id)?.permissions?.json?.sendMessages
    if (!canSend) {
      return
    }
    if (!global.bot.guildSettingsCache?.[message.channel.guild.id]) {
      await cacheGuild(message.channel.guild.id)
    }

    const trimmedSuffix = (suffix || '').trim()
    let events = trimmedSuffix ? trimmedSuffix.split(',').map(s => s.trim()).filter(Boolean) : []
    events = cleanArray(events)
    if (events.length === 0 && trimmedSuffix) {
      await message.channel.createMessage(`<@${message.author.id}>, none of the provided events are valid to be unset. Look at ${process.env.GLOBAL_BOT_PREFIX}help to see what is valid.`)
    } else if (trimmedSuffix && events.length !== 0) {
      await setEventLogs(message.channel.guild.id, '', events)
      await cacheGuild(message.channel.guild.id)
      await message.channel.createMessage(`<@${message.author.id}>, your selected events will not be logged here anymore.`)
    } else if (!trimmedSuffix) {
      await clearEventByID(message.channel.guild.id, message.channel.id) // any event logging to this channel id will be wiped
      await cacheGuild(message.channel.guild.id)

      await message.channel.createMessage({
        embeds: [{
          title: 'このチャンネルに紐づくイベントの設定を解除しました。',
          color: 16711680,
          timestamp: new Date(),
          footer: {
            icon_url: global.bot.user.avatarURL,
            text: `${global.bot.user.username}#${global.bot.user.discriminator}`
          },
          author: {
            name: `${message.author.username}#${message.author.discriminator}`,
            icon_url: message.author.avatarURL
          },
          fields: []
        }]
      })
    }
  },
  name: 'stoplogging',
  quickHelp: 'ログチャンネルで実行すると、指定した（または全ての）イベントの出力を停止します。setchannel と逆の動作で、使い方は同じです。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}stoplogging\` <- 実行したチャンネルに設定された全イベントの出力を停止
  \`${process.env.GLOBAL_BOT_PREFIX}stoplogging messageDelete, messageUpdate\` <- 実行したチャンネルの messageDelete と messageUpdate の設定を解除
  \`${process.env.GLOBAL_BOT_PREFIX}stoplogging guildMemberVerify\` <- 実行したチャンネルのメンバー認証イベントの出力を停止`,
  type: 'admin',
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
