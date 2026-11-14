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
    if (!channel?.guild || channel.type === 1 || channel.type === 3) return
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
          value: channel.name || '不明'
        }, {
          name: '作成日時',
          value: `<t:${Math.round(((channel.id / 4194304) + 1420070400000) / 1000)}:F>`
        },
        {
          name: '位置',
          value: String(channel.position ?? 0)
        }, {
          name: 'ID',
          value: `\`\`\`ini\nユーザー = 不明\nチャンネル = ${channel.id}\`\`\``
        }],
        color: 3553599
      }]
    }
    let lastCachedMessage = channel.lastMessageID ? await global.redis.get(channel.lastMessageID).catch(() => null) : null
    if (lastCachedMessage) {
      try {
        lastCachedMessage = JSON.parse(lastCachedMessage)
        const user = global.bot.users.get(lastCachedMessage.userID)
        channelDeleteEvent.embeds[0].fields.push({
          name: '最後のメッセージ',
          value: `Author: **${user ? `${user.username}#${user.discriminator}` : lastCachedMessage.userID}**\n${lastCachedMessage.content}`
        })
      } catch (_) {}
    }
    if (channel.permissionOverwrites?.size) {
      channel.permissionOverwrites.forEach(overwrite => {
        if (overwrite.type === 0 || overwrite.type === 'role') { // Should only be role anyways, but let's just be safe
          const role = channel.guild.roles?.get?.(overwrite.id)
          if (!role || role.name === '@everyone') return
          const granted = overwrite.json ? Object.keys(overwrite.json).filter(perm => overwrite.json[perm]).join(', ') : ''
          channelDeleteEvent.embeds[0].fields.push({
            name: role.name,
            value: `Type: role\nPermissions: ${granted || 'なし'}`
          })
        }
      })
    }
    const canViewAudit = channel.guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    const logs = canViewAudit && typeof channel.guild.getAuditLog === 'function'
      ? await channel.guild.getAuditLog({ limit: 5, actionType: 12 }).catch(() => ({ entries: [], users: [] }))
      : { entries: [], users: [] }
    const entries = Array.isArray(logs?.entries) ? logs.entries : []
    const log = entries.find(e => e.targetID === channel.id && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
    if (log) { // if the audit log is less than 3 seconds off
      const user = log.user
      if (user?.bot && !global.bot.guildSettingsCache[channel.guild.id]?.isLogBots?.()) return
      if (user) {
        const member = channel.guild.members?.get?.(user.id)
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
