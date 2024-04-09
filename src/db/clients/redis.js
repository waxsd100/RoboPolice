const Redis = require('ioredis')
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
  username: process.env.REDIS_USER || 'default',
  password: process.env.REDIS_PASSWORD,
  family: 0
})

module.exports = redis
