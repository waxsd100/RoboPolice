const send = require('../modules/webhooksender')
const AUDIT_ID = {
  added: 60,
  removed: 62,
  updated: 61
}

module.exports = {
  name: 'guildEmojisUpdate',
  type: 'on',
  handle: async (guild, emojis, oldEmojis) => {
    if (!guild) return
    require('../modules/emojiDescriber').schedule(guild)
    if (!Array.isArray(emojis) || !Array.isArray(oldEmojis)) return
    let type
    const guildEmojisUpdateEvent = {
      guildID: guild.id,
      eventName: 'guildEmojisUpdate',
      embeds: [{
        description: 'サーバー絵文字が更新されました',
        fields: [{
          name: '絵文字が変更されました',
          value: ''
        }, {
          name: 'ID',
          value: '```ini\nユーザー = 不明\n絵文字 = 不明```'
        }],
        color: 3553599
      }]
    }
    let emoji
    if (emojis.length > oldEmojis.length) {
      const newEmojis = emojis.filter(e => e?.id && !oldEmojis.find(o => o?.id === e.id))
      emoji = newEmojis[0]
      if (!emoji) {
        return
      }
      type = 'added'
      guildEmojisUpdateEvent.embeds[0].thumbnail = {
        url: `https://cdn.discordapp.com/emojis/${emoji.id}.png?v=1`
      }
      guildEmojisUpdateEvent.embeds[0].fields[0].name = 'Added emoji'
      guildEmojisUpdateEvent.embeds[0].fields[0].value = `名前 = ${emoji.name}\n管理対象 = ${emoji.managed ? 'はい' : 'いいえ'}\nアニメーション = ${emoji.animated ? 'はい' : 'いいえ'}\n<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`
    } else if (oldEmojis.length > emojis.length) {
      const removedEmojis = oldEmojis.filter(e => e?.id && !emojis.find(o => o?.id === e.id))
      emoji = removedEmojis[0]
      if (!emoji) return
      type = 'removed'
      guildEmojisUpdateEvent.embeds[0].fields[0].name = 'Removed emoji'
      guildEmojisUpdateEvent.embeds[0].fields[0].value = `名前 = ${emoji.name}\n管理対象 = ${emoji.managed ? 'はい' : 'いいえ'}\nアニメーション = ${emoji.animated ? 'はい' : 'いいえ'}`
    } else {
      type = 'updated'
      emoji = emojis.find(e => e?.id && oldEmojis.find(o => o?.id === e.id)?.name !== e.name)
      if (!emoji) return
      guildEmojisUpdateEvent.embeds[0].fields[0].name = 'Updated emoji'
      guildEmojisUpdateEvent.embeds[0].fields[0].value = `名前 = ${emoji.name}\n管理対象 = ${emoji.managed ? 'はい' : 'いいえ'}\nアニメーション = ${emoji.animated ? 'はい' : 'いいえ'}`
      guildEmojisUpdateEvent.embeds[0].thumbnail = {
        url: `https://cdn.discordapp.com/emojis/${emoji.id}.png?v=1`
      }
      const oldEmoji = oldEmojis.find(o => o?.id === emoji.id)
      if (!oldEmoji) {
        return
      }
      if (emoji.name !== oldEmoji.name) {
        guildEmojisUpdateEvent.embeds[0].fields[0].value += `\nName 変更前 = ${oldEmoji.name}`
      }
    }
    guildEmojisUpdateEvent.embeds[0].fields[1].value = `\`\`\`ini\nユーザー = 不明\n絵文字 = ${emoji.id}\`\`\``
    const timer = setTimeout(async () => {
      const num = AUDIT_ID[type]
      const canViewAuditLog = guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
      const logs = canViewAuditLog
        ? await guild.getAuditLog({ limit: 5, actionType: num }).catch(() => ({ entries: [], users: [] }))
        : { entries: [], users: [] }
      const log = Array.isArray(logs?.entries)
        ? logs.entries.find(e => e?.targetID === emoji.id && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
        : null
      if (log && log.user) { // if the audit log is less than 3 seconds off
        const user = log.user
        guildEmojisUpdateEvent.embeds[0].author = {
          name: `${user.username}#${user.discriminator}`,
          icon_url: user.avatarURL
        }
        guildEmojisUpdateEvent.embeds[0].fields[1].value = `\`\`\`ini\nユーザー = ${user.id}\n絵文字 = ${emoji.id}\`\`\``
      }
      await send(guildEmojisUpdateEvent)
    }, 1000)
    timer.unref?.()
  }
}
