module.exports = {
  name: 'shardResume',
  type: 'on',
  handle: async (shardID) => {
    global.logger.info(`Shard ${shardID} has resumed`)
  }
}
