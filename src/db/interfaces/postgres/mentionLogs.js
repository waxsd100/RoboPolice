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
  referencedText = null,
  response,
  model = null,
  promptTokens = 0,
  cachedTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  geminiCalls = 0
}) {
  const res = await pool.query(
    `INSERT INTO mention_logs (
       guild_id, channel_id, message_id, reply_message_id,
       user_id, user_name, kind, request, referenced_text, response,
       model, prompt_tokens, cached_tokens, output_tokens, thinking_tokens, gemini_calls
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
      referencedText,
      response ?? '',
      model,
      promptTokens || 0,
      cachedTokens || 0,
      outputTokens || 0,
      thinkingTokens || 0,
      geminiCalls || 0
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
            user_id, user_name, kind, request, referenced_text, response,
            model, prompt_tokens, cached_tokens, output_tokens, thinking_tokens, gemini_calls, created_at
     FROM mention_logs
     WHERE ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  )
  return res.rows
}

module.exports = { saveMentionLog, getMentionLogs }
