const cluster = require('cluster')

module.exports = {
  name: 'shardPreReady',
  type: 'on',
  handle: async (shardID) => {
    const label = cluster.worker?.rangeForShard ?? 'single'
    const cachedShard = global.bot?.shards?.get?.(shardID)
    global.logger.info(`[${label}] Shard ${shardID} received the READY packet`)
    if (cachedShard) {
      global.webhook.warn(`[${label}] Shard ${shardID} received READY and is processing cache\n\nResume -> ${cachedShard.resumeURL}\nStatus -> ${cachedShard.status}\nReconnecting? -> ${cachedShard.connecting ? 'yes' : 'no'}\nLast heartbeat sent: <t:${Math.ceil(cachedShard.lastHeartbeatSent / 1000)}>\nLast heartbeat received: <t:${Math.ceil(cachedShard.lastHeartbeatReceived / 1000)}>`)
    } else {
      global.webhook.warn(`[${label}] Shard ${shardID} received READY and is processing cache`)
    }
  }
}
