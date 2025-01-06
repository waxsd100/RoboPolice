const cluster = require('cluster');
const webhookLogger = require('./webhooklogger');

const workerCrashes = {};
let statsObj = {};

const allWorkers = [];

module.exports = async (worker) => {
	allWorkers.push(worker);
	worker.on('online', () => {
		global.logger.startup(`WORKER ${worker.id} started hosting ${worker.rangeForShard}`);
		worker.send({
			type: 'startup',
			processType: 'bot',
			rangeForShard: worker.rangeForShard,
			shardStart: worker.shardStart,
			shardEnd: worker.shardEnd,
			totalShards: worker.totalShards,
		});

		if (process.uptime() > 50) {
			webhookLogger.custom({
				title: `Worker ${worker.id} started`,
				description: `Hosting ${worker.shardStart}`,
			});
		}
	});

	worker.on('message', async (message) => {
		if (!message.type) return;
		if (message.type === 'stats') {
			if (!statsObj.hasOwnProperty('commandUsage')) {
				statsObj = message;
			} else {
				for (const commandName in message.commandUsage) {
					statsObj.commandUsage[commandName] += message.commandUsage[commandName];
				}
				for (const eventName in message.eventUsage) {
					statsObj.eventUsage[eventName] += message.eventUsage[eventName];
				}
				for (const miscItem in message.miscUsage) {
					statsObj.miscUsage[miscItem] += message.miscUsage[miscItem];
				}
			}
		} else if (message.type === 'debugActivity') {
			if (message.data === 'cpuusage') {
				const os = require('os-utils');

				os.cpuUsage((v) => {
					console.log(`Cluster master cpu usage: ${v * 100}%`);
				});

				os.cpuFree((v) => {
					console.log(`Cluster master cpu free: ${v * 100}%`);
				});
			}
		}
	});

	worker.on('disconnect', () => {
		console.error(`[${worker.rangeForShard}] IPC disconnected!`);
		global.webhook.error(`[${worker.rangeForShard}] IPC disconnected! <@&349414410869276673>`);
		process.exit(1);
	});

	worker.on('exit', (code) => {
		allWorkers.splice(allWorkers.indexOf(worker), 1);
		if (code === 0) {
			global.logger.info(`Worker ${worker.id} hosting ${worker.shardStart}-${worker.shardStart} successfully killed.`);
			global.webhook.generic(
				`Worker ${worker.id} hosting ${worker.shardStart}-${worker.shardStart} successfully killed.`,
			);
		} else if (workerCrashes[worker.rangeForShard] >= 2) {
			global.logger.error(
				`Worker ${worker.id} hosting ${worker.rangeForShard} will not be respawned due to a detected boot loop.`,
			);
			global.webhook.fatal(
				`Worker ${worker.id} hosting ${worker.rangeForShard} will not be respawned due to a detected boot loop. | ${worker.id}`,
			);
		} else {
			global.logger.error(
				`Worker ${worker.id} died with code ${code}, hosting ${worker.rangeForShard}. Attempting to respawn a replacement.`,
			);
			global.webhook.fatal(
				`Worker ${worker.id} died with code ${code}, hosting ${worker.rangeForShard}. Attempting to respawn a replacement.`,
			);
			const nw = cluster.fork();
			Object.assign(nw, {
				type: 'startup',
				processType: 'bot',
				rangeForShard: worker.rangeForShard,
				shardStart: worker.shardStart,
				shardEnd: worker.shardEnd,
				totalShards: worker.totalShards,
			});
			module.exports(nw);

			global.webhook.generic(`Respawned dead worker ${worker.id} hosting ${worker.rangeForShard} as ${nw.id}.`);
			if (workerCrashes[worker.rangeForShard]) workerCrashes[worker.rangeForShard]++;
			else workerCrashes[worker.rangeForShard] = 1;
			setTimeout(() => {
				if (workerCrashes[worker.rangeForShard] === 1) delete workerCrashes[worker.rangeForShard];
				else workerCrashes[worker.rangeForShard]--;
			});
		}
	});
};
