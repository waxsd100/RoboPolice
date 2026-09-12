const send = require('../modules/webhooksender')
const CHANNEL_TYPE_MAP = {
  0: 'テキストチャンネル',
  2: 'ボイスチャンネル',
  4: 'Category',
  5: 'Announcement',
  13: 'Stage Channel',
  15: 'フォーラムチャンネル'
}

module.exports = {
  name: 'channelDelete',
  type: 'on',
  handle: async channel => {
    if (channel.type === 1 || channel.type === 3) return
    const channelDeleteEvent = {
      guildID: channel.guild.id,
      eventName: 'channelDelete',
      embeds: [{
        author: {
          name: '不明なユーザー',
          icon_url: 'https://logger.bot/staticfiles/red-x.png'
        },
        description: `${CHANNEL_TYPE_MAP[channel.type] ? CHANNEL_TYPE_MAP[channel.type] : 'Unsupported channel type'} が削除されました (${channel.name})`,
        fields: [{
          name: '名前',
          value: channel.name
        }, {
          name: '作成日時',
          value: `<t:${Math.round(((channel.id / 4194304) + 1420070400000) / 1000)}:F>`
        },
        {
          name: '位置',
          value: channel.position
        }, {
          name: 'ID',
          value: `\`\`\`ini\nユーザー = Unknown\nチャンネル = ${channel.id}\`\`\``
        }],
        color: 3553599
      }]
    }
    let lastCachedMessage = await global.redis.get(channel.lastMessageID)
    if (lastCachedMessage) {
      lastCachedMessage = JSON.parse(lastCachedMessage)
      const user = global.bot.users.get(lastCachedMessage.userID)
      channelDeleteEvent.embeds[0].fields.push({
        name: '最後のメッセージ',
        value: `Author: **${user.username}#${user.discriminator}**\n${lastCachedMessage.content}`
      })
    }
    if (channel.permissionOverwrites.size !== 0) {
      channel.permissionOverwrites.forEach(overwrite => {
        if (overwrite.type === 0) { // Should only be role anyways, but let's just be safe
          const role = channel.guild.roles.find(r => r.id === overwrite.id)
          if (!role || role.name === '@everyone') return
          channelDeleteEvent.embeds[0].fields.push({
            name: role.name,
            value: `Type: role\nPermissions: ${Object.keys(overwrite.json).filter(perm => overwrite.json[perm]).join(', ')}`
          })
        }
      })
    }
    const logs = await channel.guild.getAuditLog({ limit: 5, actionType: 12 }).catch(() => {})
    if (!logs) return
    const log = logs.entries.find(e => e.targetID === channel.id && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
    if (log) { // if the audit log is less than 3 seconds off
      const user = log.user
      if (user && user?.bot && !global.bot.guildSettingsCache[channel.guild.id].isLogBots()) return
      if (user) {
        const member = channel.guild.members.get(user.id)
        channelDeleteEvent.embeds[0].author.name = `${user.username}#${user.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`
        channelDeleteEvent.embeds[0].author.icon_url = user.avatarURL
        channelDeleteEvent.embeds[0].fields[3].value = `\`\`\`ini\nユーザー = ${user.id}\nチャンネル = ${channel.id}\`\`\``
      }
      await send(channelDeleteEvent)
    } else {
      await send(channelDeleteEvent)
    }
  }
}
