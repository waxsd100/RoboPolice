const { Pool } = require('pg')
const { loadSecrets } = require('./secrets')

require('dotenv').config()

async function generate () {
  await loadSecrets()
  const port = Number(process.env.PGPORT) || 5432
  const dbName = process.env.PGDATABASE || 'logger'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
    throw new Error(`Invalid PGDATABASE identifier: "${dbName}"`)
  }

  const pool = new Pool({
    user: process.env.PGUSER, // Make sure PGUSER is a superuser
    host: process.env.PGHOST,
    database: 'template1', // Should exist in all postgres databases by default
    password: process.env.PGPASSWORD,
    port
  })

  pool.on('error', e => {
    console.error('There was an error while generating the database structure!', e)
  })

  let loggerDB
  try {
    await pool.query(`CREATE DATABASE "${dbName}"`) // create db
    loggerDB = new Pool({
      user: process.env.PGUSER,
      host: process.env.PGHOST,
      database: dbName,
      password: process.env.PGPASSWORD,
      port
    })
    loggerDB.on('error', e => {
      console.error('There was an error while migrating the database structure!', e)
    })
    // The tables themselves are made by the migrations (src/db/migrations), as at every startup.
    await require('../db/migrate').migrate({ pool: { getPostgresClient: () => loggerDB.connect() }, log: console.log })
    console.log('DB Generated!')
  } finally {
    if (loggerDB) await loggerDB.end().catch(() => {})
    await pool.end().catch(() => {})
  }
}

if (require.main === module) {
  generate().catch(e => {
    console.error('Failed to generate DB:', e)
    process.exit(1)
  })
}

module.exports = { generate }
