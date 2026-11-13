const send = require('../modules/webhooksender')

module.exports = {
  name: 'guildRoleDelete',
  type: 'on',
  handle: async (guild, role) => {
    if (!guild || !role) return
    const guildRoleDeleteEvent = {
      guildID: guild.id,
      eventName: 'guildRoleDelete',
      embeds: [{
        description: 'ロールが削除されました',
        fields: [
          {
            name: '名前',
            value: role.name || '不明'
          }, {
            name: '理由',
            value: 'なし'
          }, {
            name: 'ID',
            value: `\`\`\`ini\nロール = ${role.id}\n実行者 = Deletion upon member leaving\`\`\``
          }],
        color: role.color ? role.color : 3553599
      }]
    }
    const canViewAudit = guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    const logs = canViewAudit && typeof guild.getAuditLog === 'function'
      ? await guild.getAuditLog({ limit: 5, actionType: 32 }).catch(() => ({ entries: [], users: [] }))
      : { entries: [], users: [] }
    const entries = Array.isArray(logs?.entries) ? logs.entries : []
    const log = entries.find(e => e.targetID === role.id && (new Date().getTime() - new Date((e.id / 4194304) + 1420070400000).getTime()) < 3000)
    if (log && log.user) {
      const perp = log.user
      if (log.reason) guildRoleDeleteEvent.embeds[0].fields[1].value = log.reason
      guildRoleDeleteEvent.embeds[0].fields[2].value = `\`\`\`ini\nロール = ${role.id}\n実行者 = ${perp.id}\`\`\``
      guildRoleDeleteEvent.embeds[0].author = {
        name: `${perp.username}#${perp.discriminator}`,
        icon_url: perp.avatarURL
      }
      await send(guildRoleDeleteEvent)
    } else {
      await send(guildRoleDeleteEvent)
    }
  }
}
