const send = require('../modules/webhooksender')

module.exports = {
  name: 'guildBanAdd',
  type: 'on',
  handle: async (guild, user) => {
    const guildBanAddEvent = {
      guildID: guild.id,
      eventName: 'guildBanAdd',
      embeds: [{
        author: {
          name: `${user.username}#${user.discriminator} `,
          icon_url: user.avatarURL
        },
        description: `${user.username}#${user.discriminator} がBANされました`,
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
    /*
     * Race condition time ladies and gentlemen:
     * Why the 1 second wait from when the event is received vs fetching audit logs?
     * The bot fetches audit logs for the ban entry, but Discord is behind on publishing it.
     * The 1 second wait makes sure the bot gets the new entry on time.
     * Thanks Discord.
    */
    const canViewAudit = guild.members?.get?.(global.bot?.user?.id)?.permissions?.has?.('viewAuditLog') !== false
    const timer = setTimeout(async () => {
      const logs = canViewAudit
        ? await guild.getAuditLog({ limit: 10, actionType: 22 }).catch(() => null)
        : null
      if (!logs || !Array.isArray(logs.entries)) {
        global.logger.warn(`Guild Ban Add was unable to fetch audit logs in guild ${guild.name} (${guild.id})`)
        await send(guildBanAddEvent)
        return
      }
      const log = logs.entries.find(e => {
        if (e.targetID !== user.id) return false
        try {
          return Date.now() - (Number(BigInt(e.id) >> 22n) + 1420070400000) < 60000
        } catch (_) {
          return false
        }
      })
      if (!log) {
        global.logger.warn(`Guild Ban Add on ${guild.name} (${guild.id}) was not able to match a log.`)
        await send(guildBanAddEvent)
        return
      }
      const perp = log.user
      if (perp) {
        if (log.reason) guildBanAddEvent.embeds[0].fields[1].value = log.reason
        guildBanAddEvent.embeds[0].fields[2].value = `\`\`\`ini\nユーザー = ${user.id}\n実行者 = ${perp.id}\`\`\``
        guildBanAddEvent.embeds[0].footer = {
          text: `${perp.username}#${perp.discriminator}`,
          icon_url: perp.avatarURL
        }
      }
      await send(guildBanAddEvent)
    }, 5000)
    timer.unref?.()
  }
}
