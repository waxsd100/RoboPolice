const send = require('../modules/webhooksender')
const cacheGuild = require('../utils/cacheGuild')

module.exports = {
  name: 'voiceStateUpdate',
  type: 'on',
  handle: async (member, oldState) => {
    if (!member?.guild || !member.voiceState) return
    const state = member.voiceState
    if (!oldState || !state.channelID || !oldState.channelID) return
    const channel = member.guild.channels?.get?.(state.channelID)
    if (!channel) return
    if ((state.selfDeaf !== oldState.selfDeaf) || (state.selfMute !== oldState.selfMute)) return
    if (state.mute === oldState.mute && state.deaf === oldState.deaf) return
    if (!global.bot.guildSettingsCache[member.guild.id]) {
      await cacheGuild(member.guild.id)
    }
    if (global.bot.guildSettingsCache[member.guild.id]?.isChannelIgnored?.(state.channelID)) return
    const voiceStateUpdateEvent = {
      guildID: member.guild.id,
      eventName: 'voiceStateUpdate',
      embeds: [{
        author: {
          name: `${member.username}#${member.discriminator} ${member.nick ? `(${member.nick})` : ''}`,
          icon_url: member.avatarURL
        },
        description: `**${member.username}#${member.discriminator}** ${member.nick ? `(${member.nick})` : ''} のボイス状態が変更されました`,
        fields: [{
          name: 'ボイスチャンネル',
          value: `<#${channel.id}> (${channel.name})`
        }, {
          name: 'ID',
          value: `\`\`\`ini\nユーザー = ${member.id}\nチャンネル = ${channel.id}\n`
        }],
        color: 3553599
      }]
    }
    // if (member.guild.voiceStates.size < 20) {
    const canViewAuditLog = member.guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    if (!canViewAuditLog) return
    const logs = await member.guild.getAuditLog({ limit: 5, actionType: 24 }).catch(() => ({ entries: [], users: [] }))
    if (!logs || !Array.isArray(logs.entries)) return
    const log = logs.entries.find(e => e?.targetID === member.id && (Date.now() - ((e.id / 4194304) + 1420070400000) < 3000))
    if (!log) return
    const user = log.user
    const beforeObj = log.before || {}
    const actionName = Object.keys(beforeObj)[0]
    if (!actionName) return
    voiceStateUpdateEvent.embeds[0].fields.unshift({
      name: '操作',
      value: `${{ mute: 'サーバーミュート', deaf: 'サーバースピーカーミュート' }[actionName] || actionName}${beforeObj[actionName] ? ' を解除' : ' を設定'}` || '不明'
    })
    if (user && user.id && user.username) {
      voiceStateUpdateEvent.embeds[0].fields[voiceStateUpdateEvent.embeds[0].fields.length - 1].value += `実行者 = ${user.id}\`\`\``
      voiceStateUpdateEvent.embeds[0].footer = {
        text: `${user.username}#${user.discriminator}`,
        icon_url: user.avatarURL
      }
    } else {
      voiceStateUpdateEvent.embeds[0].fields[voiceStateUpdateEvent.embeds[0].fields.length - 1].value += '```'
    }
    await send(voiceStateUpdateEvent)
  }
}
