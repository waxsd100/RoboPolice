const send = require('../modules/webhooksender')
const statAggregator = require('../modules/statAggregator')

module.exports = {
  name: 'presenceUpdate',
  type: 'on',
  handle: async (member, oldPresence) => {
    // If not a guild member (e.g. Relationship update), ignore.
    if (!member.guild) return

    // If there is no old presence, we can't compare to detect a change.
    if (!oldPresence) return
    
    // Ignore bots
    if (member.bot && (!global.bot.guildSettingsCache[member.guild.id] || !global.bot.guildSettingsCache[member.guild.id].isLogBots())) return

    const newCustomStatus = member.activities?.find(a => a.type === 4)
    const oldCustomStatus = oldPresence.activities?.find(a => a.type === 4)

    const newState = newCustomStatus?.state || ''
    const oldState = oldCustomStatus?.state || ''

    // If custom status text hasn't changed (or it never had one), ignore
    if (newState === oldState) return
    
    statAggregator.incrementEvent('presenceUpdate')

    const presenceUpdatePayload = {
      guildID: member.guild.id,
      eventName: 'presenceUpdate',
      embeds: [{
        author: {
          name: `${member.username}#${member.discriminator}`,
          icon_url: member.avatarURL
        },
        description: `${member.mention} のカスタムステータスが変更されました`,
        fields: [
          {
            name: '変更前のステータス',
            value: oldState || '（設定なし）'
          },
          {
            name: '変更後のステータス',
            value: newState || '（設定なし）'
          },
          {
            name: 'ID',
            value: `\`\`\`ini\nユーザー = ${member.id}\`\`\``
          }
        ],
        color: 0x3838fc
      }]
    }

    await send(presenceUpdatePayload)
  }
}
