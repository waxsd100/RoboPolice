global.logger = require('./src/miscellaneous/logger')
global.webhook = require('./src/miscellaneous/webhooklogger')
global.cluster = require('cluster')
require('./src/miscellaneous/logger')
require('dotenv').config()
const { loadSecrets } = require('./src/miscellaneous/secrets')

if (global.cluster.isMaster) {
  // Workers inherit the environment when forked, so only the master reads Secret Manager.
  // Workers start only once the database schema is current.
  loadSecrets().then(async () => {
    const applied = await require('./src/db/migrate').migrate({ log: m => global.logger.startup(`[DB]: ${m}`) })
    if (applied.length) global.logger.startup(`[DB]: Applied ${applied.length} migration(s)`)
    global.logger.startup('Master node init')
    require('./primary')
    // YouTube pushes arrive here and are passed to the workers.
    require('./src/miscellaneous/websub').start()
  }).catch(e => {
    console.error(`[STARTUP]: ${e.message}`)
    process.exit(1)
  })
} else {
  require('./replica')
}
