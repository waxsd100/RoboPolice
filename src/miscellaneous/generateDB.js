const { Pool } = require('pg');

require('dotenv').config();

const pool = new Pool({
	user: process.env.PGUSER,
	host: process.env.PGHOST,
	database: 'template1',
	password: process.env.PGPASSWORD,
	port: 5432,
});

pool.on('error', (e) => {
	console.error('There was an error while generating the database structure!', e);
});

async function generate() {
	await pool.query('CREATE DATABASE logger');
	const loggerDB = new Pool({
		user: process.env.PGUSER,
		host: process.env.PGHOST,
		database: 'logger',
		password: process.env.PGPASSWORD,
		port: 5432,
	});
	await loggerDB.query(
		'CREATE TABLE messages ( id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT, attachment_b64 TEXT, ts TIMESTAMPTZ )',
	);
	await loggerDB.query(
		'CREATE TABLE guilds ( id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, ignored_channels TEXT[], disabled_events TEXT[], event_logs JSON, log_bots BOOL, custom_settings JSON )',
	);
	console.log('DB Generated!');
}

generate();
