const send = require('../modules/webhooksender')
const updateMessageByID = require('../../db/interfaces/postgres/update').updateMessageByID
const getMessageFromDB = require('../../db/interfaces/postgres/read').getMessageById
const getMessageFromBatch = require('../../db/messageBatcher').getMessage
const escape = require('markdown-escape')
const { isBeyondRetention } = require('../utils/retention')

// markdown-escape is a single exported function, I probably don't need it as a node module lol

module.exports = {
  name: 'messageUpdate',
  type: 'on',
  handle: async (newMessage, oldMessage) => {
    if (!newMessage.channel.guild || !newMessage.author) return
    if (newMessage.author.id === global.bot.user.id) return
    const member = newMessage.channel.guild.members.get(newMessage.author.id) // this member "should" be in cache at all times
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
    if (newMessage.author.bot && !global.bot.guildSettingsCache[newMessage.channel.guild.id].isLogBots()) return
    await processMessage(newMessage, oldMessage)

    async function processMessage (newMessage, oldMessage) {
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
            },
          ],
          color: 15084269
        }]
      }
      let secondMessageUpdatePayload
      if (newMessage.content.length + oldMessage.content.length > 4000) {
        // handles large message nitro editing and helps make huge message edits look nicer.
        messageUpdateEvent.embeds[0].fields.splice(1) // nuke all fields but essential message info
        secondMessageUpdatePayload = JSON.parse(JSON.stringify(messageUpdateEvent)) // deep copy initial payload
        messageUpdateEvent.embeds[0].description += `\n\n**__Now__**:\n${escape(newMessage.content.replace(/~/g, '\\~'), ['angle brackets']).replace(/\"/g, '"').replace(/`/g, '') || "なし"}`
        messageUpdateEvent.embeds[0].fields = []
        delete secondMessageUpdatePayload.embeds[0].author
        secondMessageUpdatePayload.embeds[0].description = `**__Previously__**:\n${oldMessage.content}`
        secondMessageUpdatePayload.embeds[0].fields.push({
          name: 'ID',
          value: `\`\`\`ini\nユーザー = ${newMessage.author.id}\nメッセージ = ${newMessage.id}\`\`\``
        })
        messageUpdateEvent.noFooter = true
      } else {
        let nowChunks, beforeChunks
        const escapedNewContents = escape(newMessage.content.replace(/~/g, '\\~'), ['angle brackets']).replace(/\"/g, '"').replace(/`/g, '') || "なし"
        if (escapedNewContents.length > 1000) {
          nowChunks = chunkify(escapedNewContents)
        } else {
          nowChunks = [escapedNewContents]
        }

        if (oldMessage.content.length > 1000) { // already escaped in db
          beforeChunks = chunkify(oldMessage.content.replace(/\"/g, '"').replace(/`/g, ''))
        } else {
          beforeChunks = [oldMessage.content]
        }
        if (nowChunks.length === 0) {
          nowChunks.push('<本文なし>')
        }
        if (beforeChunks.length === 0) {
          beforeChunks.push('<本文なし>')
        }
        nowChunks.forEach((chunk, i) => {
          messageUpdateEvent.embeds[0].fields.push({
            name: i === 0 ? '変更後' : '変更後（続き）',
            value: chunk
          })
        })
        beforeChunks.forEach((chunk, i) => {
          messageUpdateEvent.embeds[0].fields.push({
            name: i === 0 ? '変更前' : '変更前（続き）',
            value: chunk // previous is already escaped, don't escape again
          })
        })
        messageUpdateEvent.embeds[0].fields.push({
          name: 'ID',
          value: `\`\`\`ini\nユーザー = ${newMessage.author.id}\nメッセージ = ${newMessage.id}\`\`\``
        })
      }

      let newUrls = [];
      if (oldMessage.attachment_b64) {
        const oldImageUrls = oldMessage.attachment_b64.split("|").map(base64url => Buffer.from(base64url, "base64url").toString("utf-8")).filter(Boolean)
        newAttachmentImages = newMessage.attachments.filter(attachment => attachment.content_type.startsWith("image"))
        if (oldImageUrls.length > newAttachmentImages.length) {
          // Removed at least one image from the message
          newUrls = newAttachmentImages.map(img => img.url)
          const removedImageUrls = oldImageUrls.filter(url => !newUrls.includes(url))
          removedImageUrls.forEach( (url, indx) => messageUpdateEvent.embeds[indx] = {
            ...messageUpdateEvent.embeds[indx],
            image: { url },
            url: "https://example.com"
          })
          messageUpdateEvent.embeds[0].fields.push({
            name: `Deleted Image${(removedImageUrls.length > 1) ? 's' : ''}`,
            value: "See below"
          })
        }
      }

      let changedAttrs = {}
      if (newMessage.content !== oldMessage.content)
        changedAttrs.content = newMessage.content
      if (newUrls.length)
        changedAttrs.imageUrls = newUrls
      await updateMessageByID(newMessage.id, changedAttrs)
      await send(messageUpdateEvent)
      if (secondMessageUpdatePayload) {
        await send(secondMessageUpdatePayload)
      }
    }
  }
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
      description: `**${newMessage.author.username}#${newMessage.author.discriminator}** がメッセージを編集しました（${newMessage.channel.name}）`,
      fields: [{
        name: 'チャンネル',
        value: `<#${newMessage.channel.id}> (${newMessage.channel.name})\n[メッセージへ移動](https://discord.com/channels/${newMessage.channel.guild.id}/${newMessage.channel.id}/${newMessage.id})`
      }, {
        name: '変更前',
        value: `取得できません。保持期間（${process.env.MESSAGE_HISTORY_DAYS}日）を過ぎているため、変更前の内容は保存されていません。`
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
    const chunkedStr = toChunk.substring((1000 * i), i === 0 ? 1000 : 1000 * (i + 1))
    chunksToReturn.push(chunkedStr)
  }
  return chunksToReturn
}
