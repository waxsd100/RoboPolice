const { Client, Pool } = require('pg');

require('dotenv').config();
const pool = new Pool({
	user: process.env.PGUSER,
	host: process.env.PGHOST,
	database: process.env.PGDATABASE,
	password: process.env.PGPASSWORD,
	port: process.env.PGPORT || 5432,
	max: 5,
});

pool.on('error', (e) => {
	console.error('Postgres error', e);
});

module.exports = {
	query: async (sqlString, formatArgs) => {
		let transactionClient;
		try {
			transactionClient = await pool.connect();
			const returnVals = await transactionClient.query(sqlString, formatArgs);
			transactionClient.release();
			return returnVals;
		} catch (e) {
			if (transactionClient) transactionClient.release();
			throw new Error(e);
		}
	},
	getPostgresClient: async () => {
		try {
			const transactionClient = await pool.connect();
			return transactionClient;
		} catch (e) {
			throw new Error(e);
		}
	},
	end: (cb) => {
		pool.end(cb);
	},
};
