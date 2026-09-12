// Redis 'EX' is in SECONDS. This was 10800000, i.e. 125 days, because a millisecond
// value was passed to a seconds parameter; 3 hours is what the value was written as.
const CACHE_TTL_SECONDS = 10800

const statAggregator = require('./statAggregator')

module.exports = {
  setWebhook: (channelID, webhookID, webhookToken) => {
    statAggregator.incrementRedisSet()
    return global.redis.set(`webhook-${channelID}`, `${webhookID}|${webhookToken}`, 'EX', CACHE_TTL_SECONDS)
  },
  getWebhook: channelID => {
    statAggregator.incrementRedisGet()
    return global.redis.get(`webhook-${channelID}`)
  },
  deleteWebhook: channelID => {
    return global.redis.del(`webhook-${channelID}`)
  }
}
