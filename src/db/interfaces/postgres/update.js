const pool = require('../../clients/postgres')
const getDoc = require('./read').getGuild
const cacheGuild = require('../../../bot/utils/cacheGuild')
const getMessageFromBatch = require('../../messageBatcher').getMessage
const updateBatchMessage = require('../../messageBatcher').updateMessage
const { ALL_EVENTS } = require('../../../bot/utils/constants')

// Settings rows refer to the server's row, which getDoc makes if it is missing.
async function ensureGuild (guildID) {
  await getDoc(guildID)
}

async function clearEventLog (guildID) {
  await pool.query('DELETE FROM guild_event_logs WHERE guild_id = $1', [guildID])
  await cacheGuild(guildID)
}

// Stops logging every event that was logged to `channelID`.
async function clearEventByID (guildID, channelID) {
  await pool.query('DELETE FROM guild_event_logs WHERE guild_id = $1 AND channel_id = $2', [guildID, channelID])
  await cacheGuild(guildID)
}

// Logs `events` to `channelID`, or stops logging them when it is ''.
async function setEventsLogId (guildID, channelID, events) {
  if (events.length) {
    if (channelID) {
      await ensureGuild(guildID)
      await pool.query(
        `INSERT INTO guild_event_logs (guild_id, event, channel_id) SELECT $1, unnest($3::text[]), $2
         ON CONFLICT (guild_id, event) DO UPDATE SET channel_id = EXCLUDED.channel_id`,
        [guildID, channelID, [...new Set(events)]])
    } else {
      await pool.query('DELETE FROM guild_event_logs WHERE guild_id = $1 AND event = ANY($2)', [guildID, events])
    }
  }
  await cacheGuild(guildID)
}

async function setAllEventsOneId (guildID, channelID) {
  await setEventsLogId(guildID, channelID, ALL_EVENTS)
}

async function cleanUnusedDiscordChannels (guildID) {
  await pool.query(
    `DELETE FROM discord_channels c
     WHERE c.guild_id = $1 AND NOT c.ignored AND c.name IS NULL
       AND c.msg_backfill_at IS NULL AND c.post_backfill_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM discord_posts p WHERE p.channel_id = c.id)`,
    [guildID])
}

// Ignores the channel, or stops ignoring it if it was. Resolves to whether it is now ignored, or
// null when the channel ID belongs to another server.
async function ignoreChannel (guildID, channelID) {
  await ensureGuild(guildID)
  const res = await pool.query(
    `INSERT INTO discord_channels (id, guild_id, ignored) VALUES ($1, $2, true)
     ON CONFLICT (id) DO UPDATE SET ignored = NOT discord_channels.ignored
     WHERE discord_channels.guild_id = EXCLUDED.guild_id
     RETURNING ignored`,
    [channelID, guildID])
  if (!res.rows.length) return null
  const disabled = !!res.rows[0].ignored
  if (!disabled) await cleanUnusedDiscordChannels(guildID)
  await cacheGuild(guildID)
  const cached = global.bot?.guildSettingsCache?.[guildID]
  if (cached && Array.isArray(cached.ignoredChannels)) {
    if (disabled && !cached.ignoredChannels.includes(channelID)) {
      cached.ignoredChannels.push(channelID)
    } else if (!disabled) {
      cached.ignoredChannels = cached.ignoredChannels.filter(id => id !== channelID)
    }
  }
  return disabled
}

async function clearIgnoredChannels (guildID) {
  await pool.query('UPDATE discord_channels SET ignored = false WHERE guild_id = $1 AND ignored', [guildID])
  await cleanUnusedDiscordChannels(guildID)
  await cacheGuild(guildID)
}

// Resolves to whether bots are logged now.
async function toggleLogBots (guildID) {
  await ensureGuild(guildID)
  const rows = await pool.query('UPDATE guilds SET log_bots = NOT log_bots WHERE id = $1 RETURNING log_bots', [guildID])
  if (!rows.rows.length) return false
  await cacheGuild(guildID)
  return rows.rows[0].log_bots
}

// The server's name, icon, owner, member count and when the bot joined, as Discord has them now.
async function saveGuildDetails (guild) {
  await pool.query(
    `UPDATE guilds SET name = $2, icon_url = $3, owner_id = COALESCE($4, owner_id), member_count = $5,
       joined_at = COALESCE($6, joined_at), details_updated_at = now() WHERE id = $1`,
    [guild.id, guild.name || null, guild.iconURL || null, guild.ownerID || null, guild.memberCount ?? null, guild.joinedAt ? new Date(guild.joinedAt) : null])
}

async function updateMessageByID (id, changedAttrs) {
  const result = await updateMessageRow(id, changedAttrs)
  // Edited text is invalidated unconditionally so re-enabling message embeddings never serves stale vectors.
  if ('content' in changedAttrs) {
    await require('./embeddings').invalidateMessage(id).catch(e => global.logger.warn(`Could not reset the embedding of ${id}: ${e.message}`))
  }
  return result
}

// changedAttrs: { content } and/or { imageUrls } (the message's images now, in order).
async function updateMessageRow (id, changedAttrs) {
  if (!('content' in changedAttrs) && !('imageUrls' in changedAttrs)) {
    const msg = `updateMessageById called with unsupported changedAttrs: ${JSON.stringify(changedAttrs)}`
    global.logger.warn(msg)
    global.webhook.warn(msg)
    return
  }
  if (getMessageFromBatch(id)) return updateBatchMessage(id, changedAttrs)
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    if ('content' in changedAttrs) await client.query('UPDATE messages SET content = $1 WHERE id = $2', [changedAttrs.content || 'None', id])
    if ('imageUrls' in changedAttrs) {
      await client.query('DELETE FROM message_attachments WHERE message_id = $1', [id])
      for (const [position, url] of changedAttrs.imageUrls.entries()) {
        await client.query(
          'INSERT INTO message_attachments (message_id, position, url) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)',
          [id, position, url])
      }
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

exports.toggleLogBots = toggleLogBots
exports.ignoreChannel = ignoreChannel
exports.clearEventLog = clearEventLog
exports.clearEventByID = clearEventByID
exports.setAllEventsOneId = setAllEventsOneId
exports.setEventsLogId = setEventsLogId
exports.clearIgnoredChannels = clearIgnoredChannels
exports.updateMessageByID = updateMessageByID
exports.saveGuildDetails = saveGuildDetails
