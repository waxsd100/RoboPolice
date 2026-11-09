// Database migrations: the files in ./migrations, applied in the order of their number, each once,
// each in its own transaction. schema_migrations records what has been applied. The master process
// runs them at startup before any worker starts (and `npm run migrate` runs them by hand), under an
// advisory lock so two processes never apply the same migration at once.
//
// A migration is NNN_name.sql, or NNN_name.js exporting async (client) => {} for changes SQL alone
// can't make (such as re-encrypting stored data). Applied migrations are never edited: a change to
// the schema is a new file.
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, 'migrations')
// Any constant shared by every process of this bot: pg_advisory_lock takes a bigint.
const LOCK_ID = 7267701

function migrationFiles (dir = DIR) {
  return fs.readdirSync(dir)
    .map(file => ({ file, match: file.match(/^(\d+)_(.+)\.(sql|js)$/) }))
    .filter(f => f.match)
    .map(({ file, match }) => ({ version: Number(match[1]), name: match[2], file: path.join(dir, file), kind: match[3] }))
    .sort((a, b) => a.version - b.version)
}

async function apply (client, migration) {
  if (migration.kind === 'sql') return client.query(fs.readFileSync(migration.file, 'utf8'))
  return require(migration.file)(client)
}

const TRANSIENT_MIGRATE_ERROR = /Connection terminated|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|timeout exceeded|starting up|recovery mode|57P03/i
const MAX_MIGRATE_ATTEMPTS = 6

// Applies what has not been applied yet. Resolves to the migrations applied.
async function migrate ({ pool = require('./clients/postgres'), dir = DIR, log = () => {}, retryDelayMs = 3000 } = {}) {
  const allApplied = []
  for (let attempt = 1; attempt <= MAX_MIGRATE_ATTEMPTS; attempt++) {
    let client
    let clientBroken = false
    try {
      client = await pool.getPostgresClient()
      if (typeof client.on === 'function' && !client._hasRoboPoliceErrorHandler) {
        client._hasRoboPoliceErrorHandler = true
        client.on('error', () => { clientBroken = true })
      }
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
      // Index builds one process at a time and within 32 MB of maintenance memory: a parallel build
      // shares its memory through /dev/shm (64 MB on Railway), and an unbounded HNSW build can
      // exceed the Postgres container's RAM and trigger the OOM killer.
      await client.query('SET max_parallel_maintenance_workers = 0')
      await client.query("SET maintenance_work_mem = '32MB'")
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version))
      for (const migration of migrationFiles(dir).filter(m => !applied.has(m.version))) {
        log(`Applying migration ${migration.version} ${migration.name}`)
        try {
          await client.query('BEGIN')
          await apply(client, migration)
          await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name])
          await client.query('COMMIT')
        } catch (e) {
          await client.query('ROLLBACK').catch(() => { clientBroken = true })
          throw new Error(`Migration ${migration.version} ${migration.name} failed: ${e.message}`)
        }
        allApplied.push(migration)
      }
      return allApplied
    } catch (e) {
      clientBroken = true
      const errText = `${e?.code || ''} ${e?.message || e || ''}`
      if (attempt < MAX_MIGRATE_ATTEMPTS && TRANSIENT_MIGRATE_ERROR.test(errText)) {
        log(`Database connection failed during startup migration (${e.message || e}); retrying (${attempt}/${MAX_MIGRATE_ATTEMPTS})`)
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt))
        continue
      }
      throw e
    } finally {
      if (client) {
        if (!clientBroken) {
          await client.query('RESET maintenance_work_mem').catch(() => { clientBroken = true })
          await client.query('RESET max_parallel_maintenance_workers').catch(() => { clientBroken = true })
          await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => { clientBroken = true })
        }
        client.release(clientBroken ? new Error('Migration client closed after error') : undefined)
      }
    }
  }
  return allApplied
}

module.exports = { migrate, migrationFiles }

if (require.main === module) {
  require('dotenv').config()
  migrate({ log: console.log })
    .then(done => {
      console.log(done.length ? `Applied ${done.length} migration(s).` : 'The database is up to date.')
      process.exit(0)
    })
    .catch(e => {
      console.error(e.message)
      process.exit(1)
    })
}
