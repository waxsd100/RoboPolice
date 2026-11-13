const send = require('../modules/webhooksender')
const CHANNEL_TYPE_MAP = {
  0: 'テキストチャンネル',
  2: 'ボイスチャンネル',
  4: 'カテゴリ',
  5: 'アナウンスチャンネル',
  13: 'ステージチャンネル',
  15: 'フォーラムチャンネル'
}

module.exports = {
  name: 'channelCreate',
  type: 'on',
  handle: async newChannel => { // If it's a DM or group channel, ignore the creation
    if (!newChannel?.guild || newChannel.type === 1 || newChannel.type === 3) return
    const channelCreateEvent = {
      guildID: newChannel.guild.id,
      eventName: 'channelCreate',
      embeds: [{
        author: {
          name: '不明なユーザー',
          icon_url: 'https://logger.bot/staticfiles/red-x.png'
        },
        description: `${CHANNEL_TYPE_MAP[newChannel.type] ? CHANNEL_TYPE_MAP[newChannel.type] : 'Unsupported channel type'} created <#${newChannel.id}>`,
        fields: [{
          name: '名前',
          value: newChannel.name || '不明'
        }, {
          name: 'ID',
          value: `\`\`\`ini\nユーザー = 不明\nチャンネル = ${newChannel.id}\`\`\``
        }],
        color: 3553599
      }]
    }
    if (newChannel.permissionOverwrites?.size) {
      newChannel.permissionOverwrites.forEach(overwrite => {
        if (overwrite.type === 0 || overwrite.type === 'role') { // Should only be role anyways, but let's just be safe
          const role = newChannel.guild.roles?.get?.(overwrite.id)
          if (!role || role.name === '@everyone') return
          const granted = overwrite.json ? Object.keys(overwrite.json).filter(perm => overwrite.json[perm]).join(', ') : ''
          channelCreateEvent.embeds[0].fields.push({
            name: role.name,
            value: `Type: role\nPermissions: ${granted || 'なし'}`
          })
        }
      })
    }
    const canViewAudit = newChannel.guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    const logs = canViewAudit && typeof newChannel.guild.getAuditLog === 'function'
      ? await newChannel.guild.getAuditLog({ actionType: 10, limit: 10 }).catch(() => ({ entries: [], users: [] }))
      : { entries: [], users: [] }
    const entries = Array.isArray(logs?.entries) ? logs.entries : []
    const log = entries.find(e => e.targetID === newChannel.id && (new Date().getTime() - new Date((e.id / 4194304) + 1420070400000).getTime() < 3000))
    if (log) {
      const user = log.user
      if (user?.bot && !global.bot.guildSettingsCache[newChannel.guild.id]?.isLogBots?.()) return
      if (user) {
        const member = newChannel.guild.members?.get?.(user.id)
        channelCreateEvent.embeds[0].author.name = `${user.username}#${user.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`
        channelCreateEvent.embeds[0].author.icon_url = user.avatarURL
        channelCreateEvent.embeds[0].fields[1].value = `\`\`\`ini\nユーザー = ${user.id}\nチャンネル = ${newChannel.id}\`\`\``
      }
    }
    await send(channelCreateEvent)
  }
}
