const { Pool } = require('pg')

require('dotenv').config()

const pool = new Pool({
  user: process.env.PGUSER, // Make sure PGUSER is a superuser
  host: process.env.PGHOST,
  database: 'template1', // Should exist in all postgres databases by default
  password: process.env.PGPASSWORD,
  port: 5432
})

pool.on('error', e => {
  console.error('There was an error while generating the database structure!', e)
})

async function generate () {
  await pool.query('CREATE DATABASE logger') // create db
  const loggerDB = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: 'logger',
    password: process.env.PGPASSWORD,
    port: 5432
  })
  // The tables themselves are made by the migrations (src/db/migrations), as at every startup.
  await require('../db/migrate').migrate({ pool: { getPostgresClient: () => loggerDB.connect() }, log: console.log })
  await loggerDB.end()
  console.log('DB Generated!')
}

generate()
