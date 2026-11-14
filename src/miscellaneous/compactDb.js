// Reclaims PostgreSQL disk space safely, even when the disk is nearly full.
//
// Why plain `VACUUM FULL messages` fails near the disk limit:
//   `VACUUM FULL` writes a complete new copy of the table AND all its indexes before deleting the
//   old files. When `messages` + `messages_embedding_hnsw` already take >50% of the disk,
//   `VACUUM FULL messages` runs out of disk space ("could not extend file: No space left on device").
//
// How this script avoids that:
//   1. Runs retention pruning first (if MESSAGE_HISTORY_DAYS is set).
//   2. Drops the secondary indexes on `messages` (`messages_embedding_hnsw`, `messages_channel_ts`,
//      `messages_guild`, `messages_ts`, `messages_unembedded`) BEFORE `VACUUM FULL messages`.
//      Dropping indexes needs zero extra disk space and immediately frees 40-60% of the table's
//      footprint back to the OS.
//   3. Runs `VACUUM (FULL, ANALYZE)` on every user table (only the heap + primary key is rewritten).
//   4. Recreates the compact indexes on `messages` one at a time with `max_parallel_maintenance_workers = 0`.
require('dotenv').config()

const { prune } = require('./prune')
const { loadSecrets } = require('./secrets')

let _pool = null
function getPool () {
  if (!_pool) _pool = require('../db/clients/postgres')
  return _pool
}

function formatMB (bytes) {
  return `${(Number(bytes || 0) / (1024 * 1024)).toFixed(2)} MB`
}

async function dbSizeBytes (client) {
  const { rows } = await client.query('SELECT pg_database_size(current_database()) AS bytes')
  return Number(rows[0]?.bytes || 0)
}

async function topRelations (client, limit = 10) {
  const { rows } = await client.query(`
    SELECT c.relname AS name,
           CASE c.relkind WHEN 'r' THEN 'table' WHEN 'i' THEN 'index' WHEN 't' THEN 'toast' ELSE c.relkind::text END AS kind,
           pg_relation_size(c.oid) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i')
    ORDER BY pg_relation_size(c.oid) DESC
    LIMIT $1`, [limit])
  return rows
}

async function recreateMessageIndexes (client, log) {
  log('[COMPACT]: Recreating compact indexes on messages...')
  await client.query('CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages (channel_id, ts DESC)')
  await client.query('CREATE INDEX IF NOT EXISTS messages_guild ON messages (guild_id)')
  await client.query('CREATE INDEX IF NOT EXISTS messages_ts ON messages (ts)')
  await client.query('CREATE INDEX IF NOT EXISTS messages_unembedded ON messages (guild_id, ts DESC) WHERE embedding_model IS NULL AND embedding_batch IS NULL')
  await client.query('CREATE INDEX IF NOT EXISTS messages_embedding_batch ON messages (embedding_batch) WHERE embedding_batch IS NOT NULL')
  await client.query(`
    CREATE INDEX IF NOT EXISTS messages_embedding_hnsw ON messages
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 8, ef_construction = 32)
    WHERE embedding IS NOT NULL`)
}

async function compactDatabase ({ log = console.log } = {}) {
  const pruned = await prune().catch(() => ({ deleted: 0, days: null }))
  if (pruned.deleted > 0) {
    log(`[COMPACT]: Pruned ${pruned.deleted.toLocaleString()} expired message(s) older than ${pruned.days} days.`)
  }

  const client = await getPool().getPostgresClient()
  try {
    await client.query('SET max_parallel_maintenance_workers = 0')
    await client.query("SET maintenance_work_mem = '32MB'")
    const beforeBytes = await dbSizeBytes(client)
    log(`[COMPACT]: Database size before compaction: ${formatMB(beforeBytes)}`)
    for (const r of await topRelations(client, 8)) {
      log(`  - ${r.name} (${r.kind}): ${formatMB(r.bytes)}`)
    }

    log('[COMPACT]: Dropping secondary indexes on messages to free disk headroom before VACUUM FULL...')
    try {
      await client.query('DROP INDEX IF EXISTS messages_embedding_hnsw')
      await client.query('DROP INDEX IF EXISTS messages_channel_ts')
      await client.query('DROP INDEX IF EXISTS messages_guild_ts')
      await client.query('DROP INDEX IF EXISTS messages_guild')
      await client.query('DROP INDEX IF EXISTS messages_ts')
      await client.query('DROP INDEX IF EXISTS messages_unembedded')
      await client.query('DROP INDEX IF EXISTS messages_embedding_batch')

      const { rows: tables } = await client.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY pg_total_relation_size(quote_ident(tablename)::regclass) ASC`)

      for (const { tablename } of tables) {
        log(`[COMPACT]: Running VACUUM (FULL, ANALYZE) on ${tablename}...`)
        await client.query(`VACUUM (FULL, ANALYZE) "${tablename.replace(/"/g, '""')}"`)
      }
    } finally {
      await recreateMessageIndexes(client, log)
    }

    const afterBytes = await dbSizeBytes(client)
    const savedBytes = Math.max(0, beforeBytes - afterBytes)
    log(`[COMPACT]: Database size after compaction: ${formatMB(afterBytes)} (reclaimed ${formatMB(savedBytes)})`)
    for (const r of await topRelations(client, 8)) {
      log(`  - ${r.name} (${r.kind}): ${formatMB(r.bytes)}`)
    }
    return { beforeBytes, afterBytes, savedBytes }
  } finally {
    await client.query('RESET maintenance_work_mem').catch(() => {})
    await client.query('RESET max_parallel_maintenance_workers').catch(() => {})
    client.release()
  }
}

async function main () {
  await loadSecrets()
  const pool = getPool()
  let exitCode = 0
  try {
    await compactDatabase()
  } catch (e) {
    console.error(`[COMPACT]: ${e.message}`)
    exitCode = 1
  } finally {
    await pool.end().catch(() => {})
  }
  process.exit(exitCode)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`[COMPACT]: ${e.message}`)
    process.exit(1)
  })
}

module.exports = { compactDatabase }
