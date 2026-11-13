class GuildSettings {
  constructor (data) {
    if (!data || data.disabled) return
    if (!data.ownerID && !data.owner_id) {
      const guild = global.bot?.guilds?.get?.(data.id)
      if (guild?.ownerID) {
        data.ownerID = guild.ownerID
      } else {
        global.logger.warn('A guild settings doc is missing an ownerID!', data)
      }
    }
    this.id = data.id
    this.ignoredChannels = data.ignoredChannels || data.ignored_channels || []
    this.logBots = Boolean(data.logBots || data.log_bots)
    this.event_logs = data.event_logs || {}
    this.ownerID = data.ownerID || data.owner_id

    global.bot.guildSettingsCache[data.id] = this // someday, this will be replaced because it's dumb
  }

  eventIsDisabled (eventName) {
    return !this.event_logs?.[eventName]
  }

  getEventLogID (eventName) {
    return this.event_logs[eventName]
  }

  isChannelIgnored (channelID) {
    return this.ignoredChannels.includes(channelID)
  }

  isLogBots () {
    return this.logBots
  }

  getEventLogRaw () {
    return this.event_logs
  }

  getEventByName (name) {
    return this.event_logs[name]
  }

  eventLogByNames (channelID) {
    return Object.keys(this.event_logs).filter(event => this.event_logs[event] === channelID)
  }

  clearEventByID (id) {
    const events = this.eventLogByNames(id)
    events.forEach(name => {
      this.event_logs[name] = ''
    })
  }

  clearEventLog () {
    Object.keys(this.event_logs).forEach(event => {
      this.event_logs[event] = ''
    })
  }

  // Stored message rows exist only to render messageDelete / messageUpdate / messageDeleteBulk. A
  // guild with none of those configured can never use them, so caching there would store message
  // content we would never read. Fails open: if settings look malformed, keep the old behaviour
  // rather than silently stopping deletion logs.
  needsMessageCache () {
    if (!this.event_logs) return true
    return ['messageDelete', 'messageUpdate', 'messageDeleteBulk']
      .some(event => !!this.event_logs[event])
  }
}

module.exports = GuildSettings
