// A fresh, empty database for each test file, on the Postgres that PGHOST, PGUSER and PGPASSWORD
// point at (CI runs one as a service). Without PGHOST the tests are skipped.
const { Client } = require('pg')

const available = !!process.env.PGHOST
const name = `robopolice_test_${process.pid}_${Date.now()}`

function admin () {
  return new Client({ host: process.env.PGHOST, user: process.env.PGUSER, password: process.env.PGPASSWORD, port: process.env.PGPORT || 5432, database: 'postgres' })
}

// Creates the database and points the bot's pool at it. Must run before anything requires
// src/db/clients/postgres.
async function create () {
  const client = admin()
  await client.connect()
  await client.query(`CREATE DATABASE ${name}`)
  await client.end()
  process.env.PGDATABASE = name
}

async function drop () {
  await require('../../src/db/clients/postgres').end()
  const client = admin()
  await client.connect()
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await client.end()
}

module.exports = { available, create, drop }
