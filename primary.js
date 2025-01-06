const cluster = require('cluster');
const sa = require('superagent');
const addListeners = require('./src/miscellaneous/workerlistener');

require('dotenv').config();

async function init() {
	sa.get('https://discord.com/api/gateway/bot')
		.set('Authorization', `Bot ${process.env.BOT_TOKEN}`)
		.then(async (b) => {
			const totalShards = b.body.shards;
			const coreCount = require('os').cpus().length;
			const shardsPerWorker = coreCount > totalShards ? 1 : Math.ceil(totalShards / coreCount) + 2;
			const workerCount = Math.ceil(totalShards / shardsPerWorker);

			global.webhook.generic(
				`Shard manager is booting up. Discord recommends ${totalShards} shards. With the core count being ${coreCount}, there will be ${shardsPerWorker} shards per worker, and ${workerCount} workers.`,
			);
			global.logger.startup(
				`[SHARDER]: TOTAL SHARDS: ${totalShards}\nCore count: ${coreCount}\nShards per worker: ${shardsPerWorker}\nWorker count: ${workerCount}`,
			);

			for (let i = 0; i < workerCount; i++) {
				const shardStart = i * shardsPerWorker;
				let shardEnd = (i + 1) * shardsPerWorker - 1;
				if (shardEnd > totalShards - 1) shardEnd = totalShards - 1;
				let rangeForShard;
				if (shardStart === shardEnd) {
					rangeForShard = `shard ${shardStart}`;
				} else {
					rangeForShard = `shards ${shardStart}-${shardEnd}`;
				}

				const worker = cluster.fork();
				Object.assign(worker, {
					type: 'bot',
					shardStart,
					shardEnd,
					rangeForShard,
					totalShards,
				});
				addListeners(worker);
			}
		})
		.catch(console.error);
}

init();
