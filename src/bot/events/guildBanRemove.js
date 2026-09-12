const send = require('../modules/webhooksender')

module.exports = {
  name: 'guildBanRemove',
  type: 'on',
  handle: async (guild, user) => {
    const guildBanRemoveEvent = {
      guildID: guild.id,
      eventName: 'guildBanRemove',
      embeds: [{
        author: {
          name: `${user.username}#${user.discriminator}`,
          icon_url: user.avatarURL
        },
        description: `${user.username}#${user.discriminator} のBANが解除されました`,
        fields: [{
          name: 'ユーザー情報',
          value: `${user.username}#${user.discriminator} (${user.id}) ${user.mention} ${user.bot ? '\nBOTです' : ''}`
        }, {
          name: '理由',
          value: '理由なし'
        }, {
          name: 'ID',
          value: `\`\`\`ini\nユーザー = ${user.id}\n実行者 = 不明\`\`\``
        }],
        color: 3553599
      }]
    }
    const logs = await guild.getAuditLog({ limit: 5, actionType: 23 }).catch(() => {})
    if (!logs) return
    const log = logs.entries.find(e => e.targetID === user.id && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
    if (log && log.user && log.user.username) { // if the audit log is less than 3 seconds off
      const perp = log.user
      if (log.reason) guildBanRemoveEvent.embeds[0].fields[1].value = log.reason
      guildBanRemoveEvent.embeds[0].fields[2].value = `\`\`\`ini\nユーザー = ${user.id}\n実行者 = ${perp.id}\`\`\``
      guildBanRemoveEvent.embeds[0].footer = {
        text: `${perp.username}#${perp.discriminator}`,
        icon_url: perp.avatarURL
      }
      await send(guildBanRemoveEvent)
    } else {
      await send(guildBanRemoveEvent)
    }
  }
}
