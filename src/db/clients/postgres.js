const { Pool } = require('pg') // PREREQUISITE: Have postgres installed and your user can connect

require('dotenv').config()

const CONNECT_TIMEOUT_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS) || 15000
const RETRY_BASE_DELAY_MS = Number(process.env.PG_CONNECT_RETRY_DELAY_MS) || 500
const TRANSIENT_CONNECT_ERROR = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|Connection terminated|timeout exceeded|starting up|recovery mode|57P03/i

function maxConnectRetries () {
  if (process.env.PG_CONNECT_RETRIES !== undefined) return Number(process.env.PG_CONNECT_RETRIES) || 0
  return process.env.PGHOST ? 2 : 0
}

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT || 5432,
  max: 5, // 5 clients each, god help us all if this isn't sufficient
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  idleTimeoutMillis: 30000
})

function attachClientErrorHandler (client) {
  if (!client || typeof client.on !== 'function' || client._hasRoboPoliceErrorHandler) return client
  client._hasRoboPoliceErrorHandler = true
  // pg-pool removes its own idleListener while a client is checked out; without a listener on
  // the Client instance, a socket drop mid-query throws an unhandled 'error' event and crashes Node.
  client.on('error', (e) => {
    console.error('Postgres client error', e.message || e)
  })
  return client
}

pool.on('connect', attachClientErrorHandler)

pool.on('error', (e) => {
  console.error('Postgres error', e)
})

function isTransientConnectError (e) {
  const msg = `${e?.code || ''} ${e?.message || e || ''}`
  return TRANSIENT_CONNECT_ERROR.test(msg)
}

async function connectWithRetry () {
  const maxRetries = maxConnectRetries()
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await pool.connect()
      return attachClientErrorHandler(client)
    } catch (e) {
      if (attempt >= maxRetries || !isTransientConnectError(e)) {
        throw e instanceof Error ? e : new Error(String(e))
      }
      const delay = RETRY_BASE_DELAY_MS * (attempt + 1)
      console.warn(`[DB]: Postgres connection failed (${e.message || e}); retrying in ${delay}ms (${attempt + 1}/${maxRetries})`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

module.exports = {
  query: async (sqlString, formatArgs) => {
    // SQL injection is taken care of by node-postgres. I'm certain that
    // making my own would be pretty bad compared to a professionally vetted one.
    let transactionClient
    try {
      transactionClient = await connectWithRetry()
      const returnVals = await transactionClient.query(sqlString, formatArgs)
      transactionClient.release()
      return returnVals
    } catch (e) {
      if (transactionClient) transactionClient.release(e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  },
  getPostgresClient: async () => {
    // all calls of this must function .release() on the return value
    return connectWithRetry()
  },
  end: cb => {
    return pool.end(cb)
  }
}
