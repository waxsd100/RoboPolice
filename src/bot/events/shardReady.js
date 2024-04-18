module.exports = {
  name: 'shardReady',
  type: 'on',
  handle: async (shardID) => {
    global.logger.info(`Shard ${shardID} is fully ready`)
    global.webhook.warn(`Shard ${shardID} is fully ready`)
  }
}
