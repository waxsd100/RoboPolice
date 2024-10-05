const send = require('../modules/webhooksender')
const cacheGuild = require('../utils/cacheGuild')
const markdownEscape = require('markdown-escape')

const canUseExternal = guild => {
    const logChannelID = global.bot.guildSettingsCache[guild.id].event_logs.guildMemberUpdate
    if (logChannelID) {
      const logChannel = global.bot.getChannel(logChannelID)
      const permOverwrite = !!logChannel.permissionOverwrites.get(guild.id)?.json.useExternalEmojis
      if (permOverwrite) return true
    }
    return !!guild.roles.get(guild.id)?.permissions.json.useExternalEmojis
}

module.exports = {
    name: 'guildMemberTimeout',
    type: 'on',
    handle: async (guild, member, oldMember) => {
        if (!global.bot.guilds.get(guild.id)) { // don't try to log something when the bot isn't in the guild
            return
        }
        const guildMemberUpdate = {
            guildID: guild.id,
            eventName: 'guildMemberTimeout',
            embeds: [{
              author: {
                name: `${member.username}#${member.discriminator}`,
                icon_url: member.avatarURL
              },
              description: `${member.username}#${member.discriminator} ${member.mention} ${member.nick ? `(${member.nick})` : ''} was updated`,
              fields: [{
                name: 'Changes',
                value: 'Unknown. Look at the footer to see who updated the affected user.'
              }]
            }]
        }
        if (!global.bot.guildSettingsCache[guild.id]) {
            await cacheGuild(guild.id)
        }
        if ((oldMember && arrayCompare(member.roles, oldMember.roles) && (member.communicationDisabledUntil === oldMember.communicationDisabledUntil))) return // if roles are the same stop fetching audit logs
        const logs = await guild.getAuditLog({ limit: 5 })
        if (!logs.entries[0]) return
        const possibleTimeoutLog = logs.entries.find(e => e.targetID === member.id && e.actionType === 24 && (e.before.communication_disabled_until || e.after.communication_disabled_until) && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
        if (possibleTimeoutLog) {
            console.log("Logging timeout")
            const embedCopyTL = guildMemberUpdate
            embedCopyTL.eventName = 'guildMemberTimeout'
            embedCopyTL.embeds[0].description = `${member.username}#${member.discriminator} (${member.mention}) ${member.communicationDisabledUntil ? 'was timed out' : 'had their timeout removed'}`
            embedCopyTL.embeds[0].author = {
              name: `${member.username}#${member.discriminator}`,
              icon_url: member.avatarURL
            }
            embedCopyTL.embeds[0].footer = {
              text: `${possibleTimeoutLog.user.username}#${possibleTimeoutLog.user.discriminator}`,
              icon_url: possibleTimeoutLog.user.avatarURL
            }
            embedCopyTL.embeds[0].fields = []
            embedCopyTL.embeds[0].fields.push({
              name: 'Timeout Creator',
              value: `${possibleTimeoutLog.user.username}#${possibleTimeoutLog.user.discriminator}`
            })
            if (possibleTimeoutLog.reason) {
              embedCopyTL.embeds[0].fields.push({
                name: 'Reason',
                value: markdownEscape(possibleTimeoutLog.reason)
              })
            }
            if (member.communicationDisabledUntil) {
              embedCopyTL.embeds[0].fields.push({
                name: 'Expiration',
                value: `<t:${Math.ceil(member.communicationDisabledUntil / 1000)}> (<t:${Math.ceil(member.communicationDisabledUntil / 1000)}:R>)`
              })
            } else {
              embedCopyTL.embeds[0].fields.push({
                name: 'Expiration',
                value: `Was until <t:${Math.ceil(Date.parse(possibleTimeoutLog.before.communication_disabled_until) / 1000)}> (<t:${Math.ceil(Date.parse(possibleTimeoutLog.before.communication_disabled_until) / 1000)}:R>)`
              })
            }
            embedCopyTL.embeds[0].fields.push({
              name: 'ID',
              value: `\`\`\`ini\nUser = ${member.id}\nPerpetrator = ${possibleTimeoutLog.user.id}\`\`\``
            })
            await send(embedCopyTL)
          }
    }
}