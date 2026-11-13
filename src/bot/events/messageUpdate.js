const send = require('../modules/webhooksender')
const updateMessageByID = require('../../db/interfaces/postgres/update').updateMessageByID
const getMessageFromDB = require('../../db/interfaces/postgres/read').getMessageById
const getMessageFromBatch = require('../../db/messageBatcher').getMessage
const toStoredContent = require('../../db/interfaces/postgres/create').toStoredContent
const escape = require('markdown-escape')
const cacheGuild = require('../utils/cacheGuild')
const { getRetentionDays, isBeyondRetention } = require('../utils/retention')
const discordKnowledge = require('../modules/discordKnowledge')

// markdown-escape is a single exported function, I probably don't need it as a node module lol

function clampStr (str, maxLen) {
  if (typeof str !== 'string') str = String(str ?? '')
  if (str.length <= maxLen) return str
  let cut = str.slice(0, maxLen - 1)
  const lastCode = cut.charCodeAt(cut.length - 1)
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    cut = cut.slice(0, -1)
  }
  return cut + '…'
}

module.exports = {
  name: 'messageUpdate',
  type: 'on',
  handle: async (newMessage, oldMessage) => {
    if (!newMessage?.channel?.guild || !newMessage.author) return
    if (newMessage.author.id === global.bot.user.id) return
    discordKnowledge.onMessage(newMessage).catch(e => global.logger.warn(`[DISCORD]: ${e.message}`))
    if (!isFreshEdit(newMessage)) return
    let guildSettings = global.bot.guildSettingsCache?.[newMessage.channel.guild.id]
    if (!guildSettings) {
      await cacheGuild(newMessage.channel.guild.id)
      guildSettings = global.bot.guildSettingsCache?.[newMessage.channel.guild.id]
    }
    if (!guildSettings || guildSettings.isChannelIgnored(newMessage.channel.id)) return
    const member = newMessage.channel.guild.members?.get?.(newMessage.author.id) // this member "should" be in cache at all times
    oldMessage = await getMessageFromBatch(newMessage.id)
    if (!oldMessage) {
      oldMessage = await getMessageFromDB(newMessage.id)
    }
    if (!oldMessage) {
      // Aged out of retention: report that an edit happened even though the previous text is gone.
      if (isBeyondRetention(newMessage.id) && !newMessage.author.bot) {
        await send(expiredUpdateEvent(newMessage, member))
      }
      return
    }
    if (newMessage.author.bot && !guildSettings.isLogBots()) return
    await processMessage(newMessage, oldMessage)

    async function processMessage (newMessage, oldMessage) {
      const rawNewContent = newMessage.content ?? ''
      const rawOldContent = oldMessage.content ?? ''
      const escapedNewContents = escape(rawNewContent.replace(/~/g, '\\~'), ['angle brackets']).replace(/`/g, '') || 'なし'
      const cleanedOldContents = rawOldContent.replace(/`/g, '') || '<本文なし>'

      const messageUpdateEvent = {
        guildID: newMessage.channel.guild.id,
        eventName: 'messageUpdate',
        embeds: [{
          author: {
            name: `${newMessage.author.username}#${newMessage.author.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`,
            icon_url: newMessage.author.avatarURL
          },
          description: `**${newMessage.author.username}#${newMessage.author.discriminator}** ${member && member.nick ? `(${member.nick})` : ''} がメッセージを編集しました（${newMessage.channel.name}）`,
          fields: [
            {
              name: `${newMessage.channel.type === 10 || newMessage.channel.type === 11 || newMessage.channel.type === 12 ? 'スレッド' : 'チャンネル'}`,
              value: `<#${newMessage.channel.id}> (${newMessage.channel.name})\n[メッセージへ移動](https://discord.com/channels/${newMessage.channel.guild.id}/${newMessage.channel.id}/${newMessage.id})`
            }
          ],
          color: 15084269
        }]
      }
      let secondMessageUpdatePayload
      if (escapedNewContents.length + cleanedOldContents.length > 3500) {
        // handles large message nitro editing and helps make huge message edits look nicer.
        messageUpdateEvent.embeds[0].fields.splice(1) // nuke all fields but essential message info
        secondMessageUpdatePayload = JSON.parse(JSON.stringify(messageUpdateEvent)) // deep copy initial payload
        messageUpdateEvent.embeds[0].description = clampStr(
          `${messageUpdateEvent.embeds[0].description}\n\n**__Now__**:\n${escapedNewContents}`,
          4096
        )
        messageUpdateEvent.embeds[0].fields = []
        delete secondMessageUpdatePayload.embeds[0].author
        secondMessageUpdatePayload.embeds[0].description = clampStr(
          `**__Previously__**:\n${rawOldContent || '<本文なし>'}`,
          4096
        )
        secondMessageUpdatePayload.embeds[0].fields.push({
          name: 'ID',
          value: clampStr(`\`\`\`ini\nユーザー = ${newMessage.author.id}\nメッセージ = ${newMessage.id}\`\`\``, 1024)
        })
        messageUpdateEvent.noFooter = true
      } else {
        const nowChunks = escapedNewContents.length > 1000
          ? chunkify(escapedNewContents).slice(0, 10)
          : [escapedNewContents]
        const beforeChunks = cleanedOldContents.length > 1000 // already escaped in db
          ? chunkify(cleanedOldContents).slice(0, 10)
          : [rawOldContent || '<本文なし>']

        nowChunks.forEach((chunk, i) => {
          messageUpdateEvent.embeds[0].fields.push({
            name: i === 0 ? '変更後' : '変更後（続き）',
            value: clampStr(chunk || '<本文なし>', 1024)
          })
        })
        beforeChunks.forEach((chunk, i) => {
          messageUpdateEvent.embeds[0].fields.push({
            name: i === 0 ? '変更前' : '変更前（続き）',
            value: clampStr(chunk || '<本文なし>', 1024) // previous is already escaped, don't escape again
          })
        })
        messageUpdateEvent.embeds[0].fields.push({
          name: 'ID',
          value: clampStr(`\`\`\`ini\nユーザー = ${newMessage.author.id}\nメッセージ = ${newMessage.id}\`\`\``, 1024)
        })
      }

      let newUrls = []
      let imagesRemoved = false
      const oldImageUrls = Array.isArray(oldMessage.attachment_urls) ? oldMessage.attachment_urls : []
      if (oldImageUrls.length) {
        const newAttachmentImages = (newMessage.attachments || []).filter(attachment => attachment.content_type?.startsWith('image'))
        if (oldImageUrls.length > newAttachmentImages.length) {
          // Removed at least one image from the message
          imagesRemoved = true
          newUrls = newAttachmentImages.map(img => img.url)
          const removedImageUrls = oldImageUrls.filter(url => !newUrls.includes(url)).slice(0, 10)
          removedImageUrls.forEach((url, indx) => {
            messageUpdateEvent.embeds[indx] = {
              ...messageUpdateEvent.embeds[indx],
              image: { url },
              url: 'https://example.com'
            }
          })
          messageUpdateEvent.embeds[0].fields.push({
            name: `Deleted Image${removedImageUrls.length > 1 ? 's' : ''}`,
            value: 'See below'
          })
        }
      }

      // Compare in the stored (escaped) form: comparing raw text against it flagged any message
      // containing ~ or < > as changed even when the text was identical.
      const storedNewContent = toStoredContent(rawNewContent)
      const changedAttrs = {}
      if (storedNewContent !== rawOldContent) {
        changedAttrs.content = storedNewContent
      }
      if (imagesRemoved) {
        changedAttrs.imageUrls = newUrls
      }
      // Same text and no image removed: a pin, a new thread or a late embed unfurl that landed
      // within isFreshEdit's window after a real edit. Nothing was edited, so log nothing.
      if (Object.keys(changedAttrs).length === 0) return
      await updateMessageByID(newMessage.id, changedAttrs)
      await send(messageUpdateEvent)
      if (secondMessageUpdatePayload) {
        await send(secondMessageUpdatePayload)
      }
    }
  }
}

// Discord also sends MESSAGE_UPDATE for changes that are not edits: a thread started from the
// message, pin/unpin, link previews unfurling late, suppressed embeds, a poll closing. Those can hit
// messages of any age, and with no previous copy to compare against (messageLimit: 0, retention
// pruning) they used to be logged as edits. Only a real content edit moves edited_timestamp to now.
const EDIT_FRESHNESS_MS = 5 * 60 * 1000

function isFreshEdit (message) {
  const editedAt = message.editedTimestamp ?? Date.parse(message.edited_timestamp)
  if (!editedAt) return false
  return Date.now() - editedAt <= EDIT_FRESHNESS_MS
}

function expiredUpdateEvent (newMessage, member) {
  return {
    guildID: newMessage.channel.guild.id,
    eventName: 'messageUpdate',
    embeds: [{
      author: {
        name: `${newMessage.author.username}#${newMessage.author.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`,
        icon_url: newMessage.author.avatarURL
      },
      description: clampStr(`**${newMessage.author.username}#${newMessage.author.discriminator}** がメッセージを編集しました（${newMessage.channel.name}）`, 4096),
      fields: [{
        name: 'チャンネル',
        value: clampStr(`<#${newMessage.channel.id}> (${newMessage.channel.name})\n[メッセージへ移動](https://discord.com/channels/${newMessage.channel.guild.id}/${newMessage.channel.id}/${newMessage.id})`, 1024)
      }, {
        name: '変更前',
        value: `取得できません。保持期間（${getRetentionDays()}日）を過ぎているため、変更前の内容は保存されていません。`
      }, {
        name: 'ID',
        value: `\`\`\`ini\nユーザー = ${newMessage.author.id}\nメッセージ = ${newMessage.id}\`\`\``
      }],
      color: 15084269
    }]
  }
}

function chunkify (toChunk) {
  const lenChunks = Math.ceil(toChunk.length / 1000)
  const chunksToReturn = []
  for (let i = 0; i < lenChunks; i++) {
    const chunkedStr = toChunk.substring((1000 * i), (i + 1) * 1000)
    chunksToReturn.push(chunkedStr)
  }
  return chunksToReturn
}
