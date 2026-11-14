const cluster = require('cluster')

module.exports = {
  name: 'shardReady',
  type: 'on',
  handle: async (shardID) => {
    const label = cluster.worker?.rangeForShard ?? 'single'
    global.logger.info(`[${label}] Shard ${shardID} is fully ready`)
    global.webhook.warn(`[${label}] Shard ${shardID} is fully ready`)
  }
}
