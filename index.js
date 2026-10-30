global.logger = require('./src/miscellaneous/logger')
global.webhook = require('./src/miscellaneous/webhooklogger')
global.cluster = require('cluster')
require('./src/miscellaneous/logger')
require('dotenv').config()
const { loadSecrets } = require('./src/miscellaneous/secrets')

if (global.cluster.isMaster) {
  // Workers inherit the environment when forked, so only the master reads Secret Manager.
  loadSecrets().then(() => {
    global.logger.startup('Master node init')
    require('./primary')
  }).catch(e => {
    console.error(`[SECRETS]: ${e.message}`)
    process.exit(1)
  })
} else {
  require('./replica')
}
