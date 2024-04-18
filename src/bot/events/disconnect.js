const statAggregator = require('../modules/statAggregator')
let reconnects = 0

module.exports = {
  name: 'disconnect',
  type: 'on',
  handle: () => {
    statAggregator.incrementMisc('disconnect')
    reconnects++
    global.logger.error(`Disconnected from the gateway, ${reconnects} reconnects.`)
    if (reconnects >= 20) {
      global.bot.disconnect({ reconnect: true }) // Disconnect the bot but don't destroy member caches
    }
  }
}

setInterval(() => {
  reconnects = 0 // Reset reconnect loop counter
}, 120000)
