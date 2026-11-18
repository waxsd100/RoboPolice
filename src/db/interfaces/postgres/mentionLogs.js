// Stores each mention request and the bot's response in PostgreSQL (migrations/045_mention_logs.sql).
const pool = require('../../clients/postgres')
const { toRows } = require('../../../bot/utils/aiTranscript')

async function saveMentionLog ({
  guildID,
  channelID,
  messageID,
  replyMessageID = null,
  userID,
  userName = null,
  kind,
  request,
  prompt = null,
  response,
  model = null,
  promptTokens = 0,
  cachedTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  geminiCalls = 0,
  blockReason = null,
  fallbacks = null,
  context = null,
  aiTranscript = null,
  repliedToMessageID = null
}) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    const res = await client.query(
      `INSERT INTO mention_logs (
       guild_id, channel_id, message_id, reply_message_id,
       user_id, user_name, kind, request, prompt, response,
       model, prompt_tokens, cached_tokens, output_tokens, thinking_tokens, gemini_calls,
       block_reason, fallbacks, context
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
      [
        guildID,
        channelID,
        messageID,
        replyMessageID,
        userID,
        userName,
        kind,
        request ?? '',
        prompt,
        response ?? '',
        model,
        promptTokens || 0,
        cachedTokens || 0,
        outputTokens || 0,
        thinkingTokens || 0,
        geminiCalls || 0,
        blockReason,
        fallbacks,
        context
      ]
    )
    const id = res.rows[0]?.id ?? null
    if (id !== null) {
      await saveThread(client, id, guildID, repliedToMessageID)
      await saveTranscript(client, id, toRows(aiTranscript))
    }
    await client.query('COMMIT')
    return id
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Where a mention stands in its conversation (060_mention_log_tree.sql): its parent is the mention
// whose answer (or whose own message) it replied to, and the closure gets the mention itself and
// every ancestor of the parent.
async function saveThread (client, id, guildID, repliedToMessageID) {
  const parent = repliedToMessageID
    ? (await client.query(
        'SELECT id FROM mention_logs WHERE guild_id = $1 AND id <> $3 AND (reply_message_id = $2 OR message_id = $2) ORDER BY id DESC LIMIT 1',
        [guildID, repliedToMessageID, id]
      )).rows[0]?.id ?? null
    : null
  if (parent !== null) await client.query('UPDATE mention_logs SET parent_id = $2 WHERE id = $1', [id, parent])
  await client.query(
    `INSERT INTO mention_log_tree (ancestor_id, descendant_id, depth)
     SELECT $1::bigint, $1::bigint, 0
     UNION ALL
     SELECT ancestor_id, $1::bigint, depth + 1 FROM mention_log_tree WHERE descendant_id = $2::bigint`,
    [id, parent]
  )
}

// A mention's conversation: every mention of its thread, from the first, in order.
async function getThread (mentionLogID) {
  const res = await pool.query(
    `SELECT v.* FROM v_mention_threads v
     WHERE v.thread_id = (SELECT thread_id FROM v_mention_threads WHERE mention_log_id = $1)
     ORDER BY v.depth, v.created_at, v.mention_log_id`,
    [mentionLogID]
  )
  return res.rows
}

// The AI calls of a mention (aiTranscript.toRows): each set of system instructions once (kept
// across mentions), each call, and each message of it.
async function saveTranscript (client, mentionLogID, rows) {
  if (!rows) return
  for (const { hash, text } of rows.systems) {
    await client.query('INSERT INTO mention_ai_systems (hash, text) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING', [hash, text])
  }
  for (const call of rows.calls) {
    const res = await client.query(
      `INSERT INTO mention_ai_calls (
         mention_log_id, seq, called_at, model, purpose, system_hash, cached_content, tools,
         safety_settings, generation_config, finish_reason, block_reason, safety_ratings, usage, error
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        mentionLogID, call.seq, call.calledAt, call.model, call.purpose, call.systemHash, call.cachedContent, call.tools,
        json(call.safetySettings), json(call.generationConfig), call.finishReason, call.blockReason, json(call.safetyRatings), json(call.usage), call.error
      ]
    )
    const callID = res.rows[0].id
    for (const m of call.messages) {
      await client.query(
        'INSERT INTO mention_ai_messages (call_id, seq, direction, turn, role, kind, name, content) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [callID, m.seq, m.direction, m.turn, m.role, m.kind, m.name, m.content]
      )
    }
  }
}

const json = value => value === null || value === undefined ? null : JSON.stringify(value)

// The AI calls of a mention, in order, each with its messages (for tests and tools).
async function getAiCalls (mentionLogID) {
  const calls = (await pool.query('SELECT * FROM v_mention_ai_calls WHERE mention_log_id = $1 ORDER BY seq', [mentionLogID])).rows
  const messages = (await pool.query('SELECT * FROM v_mention_ai_messages WHERE mention_log_id = $1 ORDER BY call_seq, seq', [mentionLogID])).rows
  return calls.map(call => ({ ...call, messages: messages.filter(m => m.call_id === call.call_id) }))
}

async function getMentionLogs (guildID, { limit = 50, userID = null } = {}) {
  const params = [guildID]
  let where = 'guild_id = $1'
  if (userID) {
    params.push(userID)
    where += ` AND user_id = $${params.length}`
  }
  params.push(limit)
  const res = await pool.query(
    `SELECT id, guild_id, channel_id, message_id, reply_message_id,
            user_id, user_name, kind, request, prompt, response,
            model, prompt_tokens, cached_tokens, output_tokens, thinking_tokens, gemini_calls,
            block_reason, fallbacks, context, created_at
     FROM mention_logs
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  )
  return res.rows
}

// Who asked the bot to make what is at `path` under /channels/<guild>/: a forum post's thread ID,
// or "channelID/messageID" for a message it wrote into a channel (kind 'message').
async function findPostCreator (guildID, path, kind = 'forum') {
  if (!guildID || !path) return null
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM mention_logs
       WHERE guild_id = $1 AND kind = $3 AND strpos(response, '/channels/' || $1 || '/' || $2) > 0
       ORDER BY id ASC LIMIT 1`,
      [guildID, path, kind]
    )
    return rows[0]?.user_id || null
  } catch (e) {
    global.logger?.warn?.('Failed to look up forum post creator', e)
    return null
  }
}

module.exports = { saveMentionLog, getMentionLogs, getAiCalls, getThread, findPostCreator }
