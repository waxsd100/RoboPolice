const cluster = require('cluster')

module.exports = {
  name: 'shardResume',
  type: 'on',
  handle: async (shardID) => {
    const label = cluster.worker?.rangeForShard ?? 'single'
    global.logger.info(`[${label}] Shard ${shardID} has resumed`)
  }
}
