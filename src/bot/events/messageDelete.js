const send = require('../modules/webhooksender')
const getMessageFromDB = require('../../db/interfaces/postgres/read').getMessageById
const messageBatcher = require('../../db/messageBatcher')
const deleteMessage = require('../../db/interfaces/postgres/delete').deleteMessage
const cacheGuild = require('../utils/cacheGuild')
const { getRetentionDays, isBeyondRetention, messageTimestamp } = require('../utils/retention')
const discordKnowledge = require('../modules/discordKnowledge')

module.exports = {
  name: 'messageDelete',
  type: 'on',
  handle: async message => {
    if (!message?.id) return
    discordKnowledge.onDelete(message.id).catch(e => global.logger.warn(`[DISCORD]: ${e.message}`))

    const hasFullGuild = Boolean(message.channel?.guild?.members)
    let guildSettings = hasFullGuild ? global.bot.guildSettingsCache?.[message.channel.guild.id] : null
    if (hasFullGuild && !guildSettings) {
      try {
        await cacheGuild(message.channel.guild.id)
        guildSettings = global.bot.guildSettingsCache?.[message.channel.guild.id]
      } catch (_) {}
    }
    const shouldLog = Boolean(hasFullGuild && guildSettings && !guildSettings.isChannelIgnored(message.channel.id))

    let cachedMessage = null
    if (shouldLog) {
      cachedMessage = await messageBatcher.getMessage(message.id)
      if (!cachedMessage) {
        cachedMessage = await getMessageFromDB(message.id)
      }
    }

    const evict = messageBatcher.evictMessage || messageBatcher.removeMessage
    if (typeof evict === 'function') {
      evict(message.id)
    }
    try {
      await deleteMessage(message.id)
    } catch (e) {
      global.logger?.warn?.(`[DB] Failed to delete message ${message.id}: ${e.message}`)
    }

    if (!hasFullGuild || !guildSettings || !shouldLog) return
    if (!cachedMessage) {
      // The row aged out of the retention window. We cannot show the content, but staying silent
      // would mean an old message can be deleted without leaving any trace at all.
      if (isBeyondRetention(message.id)) await send(expiredMessageEvent(message))
      return
    }

    let cachedUser = global.bot.users.get(cachedMessage.author_id)
    if (!cachedUser) {
      try {
        cachedUser = await message.channel.guild.getRESTMember(cachedMessage.author_id)
        message.channel.guild.members.add(cachedUser, global.bot)
      } catch (_) {
        // either the member does not exist or the person left and others are deleting their messages
      }
    }
    const member = message.channel.guild.members.get(cachedMessage.author_id)
    const nick = member?.nick || cachedUser?.nick
    const messageDeleteEvent = {
      guildID: message.channel.guild.id,
      eventName: 'messageDelete',
      embeds: [{
        author: {
          name: cachedUser ? `${cachedUser.username}#${cachedUser.discriminator} ${nick ? `(${nick})` : ''}` : `不明なユーザー <@${cachedMessage.author_id}>`,
          icon_url: cachedUser ? cachedUser.avatarURL : 'https://logger.bot/staticfiles/red-x.png'
        },
        description: `<#${message.channel.id}> でメッセージが削除されました`,
        fields: [],
        color: 8530669
      }]
    }
    let messageChunks = []
    if (cachedMessage.content) {
      if (cachedMessage.content.length > 1000) {
        messageChunks = chunkify(cachedMessage.content.replace(/`/g, '')).slice(0, 20)
      } else {
        messageChunks.push(cachedMessage.content)
      }
    } else {
      messageChunks.push('<本文なし>')
    }
    messageChunks.forEach((chunk, i) => {
      messageDeleteEvent.embeds[0].fields.push({
        name: i === 0 ? '内容' : '続き',
        value: chunk
      })
    })
    messageDeleteEvent.embeds[0].fields.push({
      name: '日時',
      value: `<t:${Math.round(cachedMessage.ts / 1000)}:F>`
    }, {
      name: 'ID',
      value: `\`\`\`ini\nユーザー = ${cachedMessage.author_id}\nメッセージ = ${cachedMessage.id}\`\`\`\n <@${cachedMessage.author_id}>`
    })

    ;(cachedMessage.attachment_urls || []).slice(0, 10).forEach((url, indx) => {
      messageDeleteEvent.embeds[indx] = {
        ...messageDeleteEvent.embeds[indx],
        image: { url },
        url: 'https://example.com'
      }
    })
    await send(messageDeleteEvent)
  }
}

function chunkify (toChunk) {
  const lenChunks = Math.ceil(toChunk.length / 1000)
  const chunksToReturn = []
  for (let i = 0; i < lenChunks; i++) {
    const chunkedStr = toChunk.substring((1000 * i), i === 0 ? 1000 : 1000 * (i + 1))
    chunksToReturn.push(chunkedStr)
  }
  return chunksToReturn
}

function expiredMessageEvent (message) {
  return {
    guildID: message.channel.guild.id,
    eventName: 'messageDelete',
    embeds: [{
      author: {
        name: '不明なユーザー',
        icon_url: 'https://logger.bot/staticfiles/red-x.png'
      },
      description: `<#${message.channel.id}> でメッセージが削除されました`,
      fields: [{
        name: '内容',
        value: `取得できません。保持期間（${getRetentionDays()}日）を過ぎているため、内容は保存されていません。`
      }, {
        name: '日時',
        value: `<t:${Math.round(messageTimestamp(message.id) / 1000)}:F>`
      }, {
        name: 'ID',
        value: `\`\`\`ini\nメッセージ = ${message.id}\`\`\``
      }],
      color: 8530669
    }]
  }
}
