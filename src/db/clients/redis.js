const Redis = require('ioredis');
const redis = new Redis({
	host: process.env.REDIS_HOST || 'localhost',
	port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : 6379,
	db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : 2,
});

module.exports = redis;
