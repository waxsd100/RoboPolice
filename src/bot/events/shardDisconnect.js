module.exports = {
  name: 'shardDisconnect',
  type: 'on',
  handle: async (err, shardID) => {
    global.logger.info(`Shard ${shardID} disconnected with error`, err)
  }
}
