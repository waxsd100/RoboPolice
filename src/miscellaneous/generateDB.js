const { Pool } = require('pg')

require('dotenv').config()

async function generateTables () {
  console.log('Trying to create tables if they don\'t already exist')
  const loggerDB = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: 'logger',
    password: process.env.PGPASSWORD,
    port: 5432
  })
  loggerDB.on('error', e => {
    console.error('There was an error while generating the database structure!', e)
  })
  try {
    const msgQuery = await loggerDB.query('CREATE TABLE IF NOT EXISTS messages ( id TEXT PRIMARY KEY, author_id TEXT NOT NULL, content TEXT, attachment_b64 TEXT, ts TIMESTAMPTZ )') // establish messages table
    const guildQuery = await loggerDB.query('CREATE TABLE IF NOT EXISTS guilds ( id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, ignored_channels TEXT[], disabled_events TEXT[], event_logs JSON, log_bots BOOL, custom_settings JSON )') // establish guilds table
    console.log(`DB generation completed, ${msgQuery.rowCount > 0 ? 'generated' : 'skipped'} messages table, ${guildQuery.rowCount > 0 ? 'generated' : 'skipped'} guilds table`)
  } catch (e) {
    console.error('Failed to generate tables for the database', e)
  }
  loggerDB.end()
}

if (require.main === module) {
  generateTables()
    .then(() => {
      process.exit(0)
    })
    .catch(e => {
      console.error('generateTables failed', e)
      process.exit(1)
    })
}

module.exports.generateTables = generateTables
