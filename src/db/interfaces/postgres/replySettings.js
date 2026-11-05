// How the mention assistant replies in each server: how long (migrations/025_reply_length.sql,
// /replylength), whether it speaks as the streamer (026_streamer_persona.sql, /persona) and whether
// its replies end with the debug line (029_debug_footer.sql, %debugfooter), and its own mention
// token limits (031_guild_token_limits.sql, %tokenlimit).
const pool = require('../../clients/postgres')

// { replyLength: 'long' | 'normal' | 'short' | null, streamerPersona: boolean, debugFooter: boolean,
// tokenLimits: { '5h', week, flexAt } (each a number, or null for the default) and unlimited
// (032_guild_unlimited.sql) } for the server.
async function getReplySettings (guildID) {
  const rows = await pool.query('SELECT reply_length, streamer_persona, debug_footer, token_limit_5h, token_limit_week, token_flex_at, token_unlimited FROM guilds WHERE id = $1', [guildID])
  const row = rows.rows[0]
  return {
    replyLength: row?.reply_length || null,
    streamerPersona: row ? row.streamer_persona !== false : true,
    debugFooter: row?.debug_footer === true,
    tokenLimits: { '5h': row?.token_limit_5h ?? null, week: row?.token_limit_week ?? null, flexAt: row?.token_flex_at ?? null, unlimited: row?.token_unlimited === true }
  }
}

async function getReplyLength (guildID) {
  return (await getReplySettings(guildID)).replyLength
}

// Makes the guild's row if there is none yet.
async function ensureGuild (guildID) {
  await require('./read').getGuild(guildID)
}

async function setReplyLength (guildID, length) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET reply_length = $2 WHERE id = $1', [guildID, length])
}

async function setStreamerPersona (guildID, enabled) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET streamer_persona = $2 WHERE id = $1', [guildID, enabled])
}

async function setDebugFooter (guildID, enabled) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET debug_footer = $2 WHERE id = $1', [guildID, enabled])
}

// Sets one of the server's token limits: which is '5h', 'week' or 'flexAt'; value a number, or null
// for the default.
// 'unlimited' takes true or false.
const TOKEN_COLUMNS = { '5h': 'token_limit_5h', week: 'token_limit_week', flexAt: 'token_flex_at', unlimited: 'token_unlimited' }
async function setTokenLimit (guildID, which, value) {
  const column = TOKEN_COLUMNS[which]
  if (!column) throw new Error(`No token limit ${which}`)
  await ensureGuild(guildID)
  await pool.query(`UPDATE guilds SET ${column} = $2 WHERE id = $1`, [guildID, value])
}

module.exports = { setTokenLimit, getReplySettings, getReplyLength, setReplyLength, setStreamerPersona, setDebugFooter }
