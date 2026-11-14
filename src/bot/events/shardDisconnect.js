const cluster = require('cluster')

module.exports = {
  name: 'shardDisconnect',
  type: 'on',
  handle: async (err, shardID) => {
    const label = cluster.worker?.rangeForShard ?? 'single'
    global.logger.info(`[${label}] Shard ${shardID} disconnected with error`, err)
  }
}
