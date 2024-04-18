module.exports = {
  name: 'debug',
  type: 'once',
  handle: async (message) => {
    // this event is spammy
    // global.logger.debug(`[DEBUG]: ${message}`)
  }
}
