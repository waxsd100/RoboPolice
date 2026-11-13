// How the mention assistant and background AI tasks run in each server: how long replies are
// (migrations/025_reply_length.sql, /replylength), whether it speaks as the streamer
// (026_streamer_persona.sql, /persona), whether its replies end with the debug line
// (029_debug_footer.sql, %debugfooter), its own mention token limits (031_guild_token_limits.sql,
// %tokenlimit), its own model, thinking level and service tier per task (036_guild_reply_model.sql,
// 040_guild_ai_models.sql, %replymodel), and what its moderators ask the assistant to keep to
// (037_guild_assistant_rules.sql, /assistantrules).
const pool = require('../../clients/postgres')
const { AI_TASKS } = require('../../../bot/utils/replyOptions')
const { isOwnerGuild } = require('../../../bot/utils/priority')

// { replyLength: 'long' | 'normal' | 'short' | null, streamerPersona: boolean, debugFooter: boolean,
// tokenLimits: { '5h', week, flexAt, unlimited }, replyModel and replyThinking (null for the
// default), aiModels: { [task]: { model, thinking, tier } }, assistantRules (text or null),
// embeddings: { messages: boolean | null, emojis: boolean | null }, embedMessages: boolean,
// embedEmojis: boolean, safety: { filter: boolean | null, uncensored: boolean | null },
// safetyFilter: boolean, uncensoredR18: boolean }.
async function getReplySettings (guildID) {
  const [rows, taskRows] = await Promise.all([
    pool.query('SELECT reply_length, streamer_persona, debug_footer, token_limit_5h, token_limit_week, token_flex_at, token_unlimited, assistant_rules, embed_messages, embed_emojis, safety_filter, uncensored_r18 FROM guilds WHERE id = $1', [guildID]),
    pool.query('SELECT task, model, thinking, tier FROM guild_ai_models WHERE guild_id = $1', [guildID])
  ])
  const row = rows.rows[0]
  const aiModels = {}
  for (const r of taskRows.rows) {
    aiModels[r.task] = { model: r.model || null, thinking: r.thinking || null, tier: r.tier || null }
  }
  const owner = isOwnerGuild(guildID)
  return {
    replyLength: row?.reply_length || null,
    streamerPersona: row ? row.streamer_persona !== false : true,
    debugFooter: row?.debug_footer === true,
    tokenLimits: { '5h': row?.token_limit_5h ?? null, week: row?.token_limit_week ?? null, flexAt: row?.token_flex_at ?? null, unlimited: row?.token_unlimited === true },
    replyModel: aiModels.reply?.model || null,
    replyThinking: aiModels.reply?.thinking || null,
    aiModels,
    assistantRules: row?.assistant_rules || null,
    embeddings: {
      messages: row?.embed_messages ?? null,
      emojis: row?.embed_emojis ?? null
    },
    embedMessages: row?.embed_messages ?? owner,
    embedEmojis: row?.embed_emojis ?? owner,
    safety: {
      filter: row?.safety_filter ?? null,
      uncensored: row?.uncensored_r18 ?? null
    },
    safetyFilter: row?.safety_filter ?? !owner,
    uncensoredR18: row?.uncensored_r18 ?? owner
  }
}

async function isEmbedMessagesEnabled (guildID) {
  if (!guildID) return false
  const { rows } = await pool.query('SELECT embed_messages FROM guilds WHERE id = $1', [guildID])
  return rows[0]?.embed_messages ?? isOwnerGuild(guildID)
}

async function isEmbedEmojisEnabled (guildID) {
  if (!guildID) return false
  const { rows } = await pool.query('SELECT embed_emojis FROM guilds WHERE id = $1', [guildID])
  return rows[0]?.embed_emojis ?? isOwnerGuild(guildID)
}

async function getTaskModel (guildID, task) {
  if (!AI_TASKS.includes(task)) return null
  if (guildID) {
    const { rows } = await pool.query('SELECT model, thinking, tier FROM guild_ai_models WHERE guild_id = $1 AND task = $2', [guildID, task])
    return rows[0] ? { model: rows[0].model || null, thinking: rows[0].thinking || null, tier: rows[0].tier || null } : null
  }
  const { rows } = await pool.query('SELECT model, thinking, tier FROM guild_ai_models WHERE task = $1 ORDER BY guild_id LIMIT 1', [task])
  return rows[0] ? { model: rows[0].model || null, thinking: rows[0].thinking || null, tier: rows[0].tier || null } : null
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

const EMBED_COLUMNS = { messages: 'embed_messages', emojis: 'embed_emojis' }
async function setEmbedding (guildID, which, value) {
  if (which === 'all') {
    await ensureGuild(guildID)
    await pool.query('UPDATE guilds SET embed_messages = $2, embed_emojis = $2 WHERE id = $1', [guildID, value])
    return
  }
  const column = EMBED_COLUMNS[which]
  if (!column) throw new Error(`No embedding setting ${which}`)
  await ensureGuild(guildID)
  await pool.query(`UPDATE guilds SET ${column} = $2 WHERE id = $1`, [guildID, value])
}

const SAFETY_COLUMNS = { filter: 'safety_filter', uncensored: 'uncensored_r18' }
async function setSafety (guildID, which, value) {
  if (which === 'all') {
    await ensureGuild(guildID)
    const filterVal = value === null ? null : Boolean(value)
    const uncensoredVal = value === null ? null : !value
    await pool.query('UPDATE guilds SET safety_filter = $2, uncensored_r18 = $3 WHERE id = $1', [guildID, filterVal, uncensoredVal])
    return
  }
  const column = SAFETY_COLUMNS[which]
  if (!column) throw new Error(`No safety setting ${which}`)
  await ensureGuild(guildID)
  await pool.query(`UPDATE guilds SET ${column} = $2 WHERE id = $1`, [guildID, value])
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

const TASK_COLUMNS = { model: 'model', thinking: 'thinking', tier: 'tier' }
async function setTaskModel (guildID, task, which, value) {
  if (!AI_TASKS.includes(task)) throw new Error(`No AI task ${task}`)
  if (which === 'all') {
    await ensureGuild(guildID)
    await pool.query('DELETE FROM guild_ai_models WHERE guild_id = $1 AND task = $2', [guildID, task])
    return
  }
  const col = TASK_COLUMNS[which]
  if (!col) throw new Error(`No reply setting ${which}`)
  await ensureGuild(guildID)
  await pool.query(
    `INSERT INTO guild_ai_models (guild_id, task, ${col}) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, task) DO UPDATE SET ${col} = EXCLUDED.${col}`,
    [guildID, task, value]
  )
  await pool.query('DELETE FROM guild_ai_models WHERE guild_id = $1 AND task = $2 AND model IS NULL AND thinking IS NULL AND tier IS NULL', [guildID, task])
}

// Sets the server's model ('model'), thinking level ('thinking') or tier ('tier') for mention
// replies; null for the default.
async function setReplyModel (guildID, which, value) {
  return setTaskModel(guildID, 'reply', which, value)
}

// Sets what the server's moderators ask the assistant to keep to; null for nothing.
async function setAssistantRules (guildID, text) {
  await ensureGuild(guildID)
  await pool.query('UPDATE guilds SET assistant_rules = $2 WHERE id = $1', [guildID, text])
}

module.exports = { setAssistantRules, setReplyModel, setTaskModel, getTaskModel, setTokenLimit, getReplySettings, getReplyLength, setReplyLength, setStreamerPersona, setDebugFooter, setEmbedding, isEmbedMessagesEnabled, isEmbedEmojisEnabled, setSafety }
