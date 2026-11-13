const cluster = require('cluster')
const path = require('path')

let botLoaded = false
let exiting = false

function earlyShutdown () {
  if (botLoaded || exiting) return
  exiting = true
  process.exit(0)
}

process.on('SIGINT', earlyShutdown)
process.on('SIGTERM', earlyShutdown)

async function assignWorkerInfo (info) {
  if (info?.type !== 'startup') {
    cluster.worker.once('message', assignWorkerInfo)
    return
  }

  if (info.processType === 'bot') {
    botLoaded = true
    process.removeListener('SIGINT', earlyShutdown)
    process.removeListener('SIGTERM', earlyShutdown)
    Object.assign(cluster.worker, info)
    require(path.join(__dirname, 'src', 'bot', 'index'))
  }
}

cluster.worker.once('message', assignWorkerInfo)
