// Stores each mention request and the bot's response in PostgreSQL (migrations/045_mention_logs.sql).
const pool = require('../../clients/postgres')

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
  aiTranscript = null
}) {
  const res = await pool.query(
    `INSERT INTO mention_logs (
       guild_id, channel_id, message_id, reply_message_id,
       user_id, user_name, kind, request, prompt, response,
       model, prompt_tokens, cached_tokens, output_tokens, thinking_tokens, gemini_calls,
       block_reason, fallbacks, context, ai_transcript
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
      context,
      aiTranscript ? JSON.stringify(aiTranscript) : null
    ]
  )
  return res.rows[0]?.id ?? null
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
            block_reason, fallbacks, context, ai_transcript, created_at
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

module.exports = { saveMentionLog, getMentionLogs, findPostCreator }
