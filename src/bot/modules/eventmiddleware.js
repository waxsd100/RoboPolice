const cacheGuild = require('../utils/cacheGuild')

// I generally hate middleware associated with events, but this could potentially save
// a whole lot on resources and audit log fetching if pulled off correctly.

const SIBLING_EVENTS = {
  guildMemberUpdate: ['guildMemberBoostUpdate', 'guildMemberNickUpdate', 'guildMemberVerify'],
  guildMemberRemove: ['guildMemberKick'],
  voiceStateUpdate: ['voiceChannelSwitch']
}

function getValidLogChannel (guildSettings, eventName, requiredPerms) {
  const isDisabled = typeof guildSettings.eventIsDisabled === 'function'
    ? guildSettings.eventIsDisabled(eventName)
    : !guildSettings.event_logs?.[eventName]
  if (isDisabled) return null

  const channelId = typeof guildSettings.getEventByName === 'function'
    ? guildSettings.getEventByName(eventName)
    : guildSettings.event_logs?.[eventName]
  if (!channelId) return null

  const logChannel = global.bot.getChannel(channelId)
  if (!logChannel) return null

  let botPerms
  try {
    botPerms = logChannel.permissionsOf(global.bot.user.id)?.json
  } catch (_) {
    return null
  }
  if (!botPerms) return null
  if (!botPerms.viewChannel || (!botPerms.manageWebhooks && !botPerms.sendMessages)) return null

  // so far, this perm check is only needed for guild member add (fetch invites)
  if (requiredPerms && requiredPerms.length !== 0) {
    for (let i = 0; i < requiredPerms.length; i++) {
      if (!botPerms[requiredPerms[i]]) return null
    }
  }
  return logChannel
}

module.exports = async (event, type) => {
  if (type === 'on') {
    global.bot.on(event.name, async (...args) => {
      const guildId = getGuildIdByEvent(event.name, args)

      if (!guildId) {
        global.logger.warn(`While executing event ${event.name}, a guild ID was not returned!`)
      } else if (guildId === true) { // when true, don't fetch event logs
        await event.handle.apply(this, args)
      } else {
        if (!global.bot.guildSettingsCache[guildId]) {
          await cacheGuild(guildId)
        }

        const guildSettings = global.bot.guildSettingsCache[guildId]
        if (!guildSettings) return

        const candidates = [event.name, ...(SIBLING_EVENTS[event.name] || [])]
        const validChannel = candidates.some(evName => getValidLogChannel(guildSettings, evName, event.requiredPerms))
        if (!validChannel) return

        await event.handle.apply(this, args)
      }
    })
  } else if (type === 'once') {
    global.bot.once(event.name, async (...args) => {
      await event.handle.apply(this, args)
    })
  }
}

// Return the id of the guild to prevent event processing if not configured by the user.
// IDs get checked for the presence of a configuration, while true is executed without a settings check.
function getGuildIdByEvent (type, args) {
  switch (type) {
    case 'channelCreate':
    case 'channelDelete':
    case 'channelUpdate': {
      return args[0]?.guild?.id
    }
    case 'guildBanAdd':
    case 'guildBanRemove':
    case 'guildEmojisUpdate':
    case 'guildStickersUpdate':
    case 'guildMemberAdd':
    case 'guildMemberRemove':
    case 'guildMemberUpdate':
    case 'guildRoleCreate':
    case 'guildRoleDelete':
    case 'guildRoleUpdate':
    case 'guildUpdate': {
      return args[0]?.id
    }
    case 'presenceUpdate':
    case 'voiceChannelJoin':
    case 'voiceChannelLeave':
    case 'voiceChannelSwitch':
    case 'voiceStateUpdate': {
      return args[0]?.guild?.id // voiceStateUpdate can return just a user id and cached voice state
    }
    case 'inviteDelete':
    case 'inviteCreate': {
      return true // yes this coulda been left to default, but this explicitly states the purpose. This needs to run whether it's configured or not
    }
    case 'messageDeleteBulk': {
      const first = args[0]?.[0]
      if (!first) return
      return first.channel?.guild?.id || first.guildID || first.guildId
    }
    default: {
      return true
    }
  }
}
