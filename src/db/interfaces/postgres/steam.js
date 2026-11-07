// The Steam accounts the bot follows and their games, reviews and wishlist: migrations/039_steam.sql.
const pool = require('../../clients/postgres')

// Follows exactly these Steam accounts ([{ steamId, accountRef, personaName, customUrl, summary,
// memberSince, level, gameCount, wishlistCount }]): others are dropped with their games and reviews.
async function setProfiles (profiles) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM steam_profiles WHERE NOT (steam_id = ANY($1::text[]))', [profiles.map(p => p.steamId)])
    for (const p of profiles) {
      await client.query('DELETE FROM steam_profiles WHERE account_ref = $1 AND steam_id <> $2', [p.accountRef, p.steamId])
      await client.query(
        `INSERT INTO steam_profiles (steam_id, account_ref, persona_name, custom_url, summary, member_since, level, game_count, wishlist_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (steam_id) DO UPDATE SET
           account_ref = $2,
           persona_name = COALESCE($3, steam_profiles.persona_name),
           custom_url = COALESCE($4, steam_profiles.custom_url),
           summary = COALESCE($5, steam_profiles.summary),
           member_since = COALESCE($6, steam_profiles.member_since),
           level = COALESCE($7, steam_profiles.level),
           game_count = COALESCE($8, steam_profiles.game_count),
           wishlist_count = COALESCE($9, steam_profiles.wishlist_count)`,
        [
          p.steamId,
          p.accountRef,
          p.personaName || null,
          p.customUrl || null,
          p.summary || null,
          p.memberSince || null,
          Number.isInteger(p.level) ? p.level : null,
          Number.isInteger(p.gameCount) ? p.gameCount : null,
          Number.isInteger(p.wishlistCount) ? p.wishlistCount : null
        ])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function listProfiles () {
  return (await pool.query(
    'SELECT steam_id, account_ref, persona_name, custom_url, summary, member_since, level, game_count, wishlist_count, synced_at FROM steam_profiles ORDER BY account_ref'
  )).rows
}

// App names already looked up on the Steam store: Map<appId, { name, nameEn }>.
async function knownApps (appIds) {
  if (!appIds.length) return new Map()
  const rows = await pool.query('SELECT app_id, name, name_en FROM steam_apps WHERE app_id = ANY($1::int[])', [appIds])
  return new Map(rows.rows.map(r => [r.app_id, { name: r.name, nameEn: r.name_en }]))
}

async function saveApps (apps) {
  if (!apps.length) return
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    for (const a of apps) {
      await client.query(
        `INSERT INTO steam_apps (app_id, name, name_en) VALUES ($1, $2, $3)
         ON CONFLICT (app_id) DO UPDATE SET name = $2, name_en = COALESCE($3, steam_apps.name_en)`,
        [a.appId, a.name, a.nameEn || null])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// Stores an account's games, reviews and wishlist. Games accumulate across syncs (so a game seen in
// recent play or a past year's replay stays); reviews and wishlist are replaced when a non-empty list
// is read. Resolves to { newGames, newReviews }.
async function saveAccountData (steamId, { profile = {}, games = [], reviews = null, wishlist = null } = {}) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    const knownGames = new Set((await client.query('SELECT app_id FROM steam_games WHERE steam_id = $1', [steamId])).rows.map(r => r.app_id))
    const knownReviews = new Set((await client.query('SELECT app_id FROM steam_reviews WHERE steam_id = $1', [steamId])).rows.map(r => r.app_id))

    for (const g of games) {
      await client.query(
        `INSERT INTO steam_games (steam_id, app_id, name, name_en, playtime_hours, recent_hours, first_played_at, last_played_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (steam_id, app_id) DO UPDATE SET
           name = $3,
           name_en = COALESCE($4, steam_games.name_en),
           playtime_hours = CASE
             WHEN $5::real IS NULL THEN steam_games.playtime_hours
             WHEN steam_games.playtime_hours IS NULL THEN $5::real
             ELSE GREATEST(steam_games.playtime_hours, $5::real)
           END,
           recent_hours = $6,
           first_played_at = COALESCE($7, steam_games.first_played_at),
           last_played_at = COALESCE($8, steam_games.last_played_at)`,
        [
          steamId,
          g.appId,
          g.name,
          g.nameEn || null,
          Number.isFinite(g.playtimeHours) ? g.playtimeHours : null,
          Number.isFinite(g.recentHours) ? g.recentHours : null,
          g.firstPlayedAt || null,
          g.lastPlayedAt || null
        ])
    }

    if (Array.isArray(reviews)) {
      for (const [position, r] of reviews.entries()) {
        await client.query(
          `INSERT INTO steam_reviews (steam_id, app_id, name, recommended, hours_on_record, posted, content, url, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (steam_id, app_id) DO UPDATE SET
             name = COALESCE($3, steam_reviews.name),
             recommended = $4,
             hours_on_record = COALESCE($5, steam_reviews.hours_on_record),
             posted = COALESCE($6, steam_reviews.posted),
             content = $7,
             url = $8,
             position = $9`,
          [
            steamId,
            r.appId,
            r.name || null,
            Boolean(r.recommended),
            Number.isFinite(r.hoursOnRecord) ? r.hoursOnRecord : null,
            r.posted || null,
            r.content,
            r.url,
            position
          ])
      }
      if (reviews.length) {
        await client.query('DELETE FROM steam_reviews WHERE steam_id = $1 AND NOT (app_id = ANY($2::int[]))', [steamId, reviews.map(r => r.appId)])
      }
    }

    if (Array.isArray(wishlist)) {
      for (const w of wishlist) {
        await client.query(
          `INSERT INTO steam_wishlist (steam_id, app_id, name, name_en, priority, added_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (steam_id, app_id) DO UPDATE SET
             name = $3,
             name_en = COALESCE($4, steam_wishlist.name_en),
             priority = $5,
             added_at = COALESCE($6, steam_wishlist.added_at)`,
          [
            steamId,
            w.appId,
            w.name,
            w.nameEn || null,
            Number.isInteger(w.priority) ? w.priority : null,
            w.addedAt || null
          ])
      }
      if (wishlist.length) {
        await client.query('DELETE FROM steam_wishlist WHERE steam_id = $1 AND NOT (app_id = ANY($2::int[]))', [steamId, wishlist.map(w => w.appId)])
      }
    }

    await client.query(
      `UPDATE steam_profiles SET
         persona_name = COALESCE($2, persona_name),
         custom_url = COALESCE($3, custom_url),
         summary = COALESCE($4, summary),
         member_since = COALESCE($5, member_since),
         level = COALESCE($6, level),
         game_count = COALESCE($7, game_count),
         wishlist_count = COALESCE($8, wishlist_count),
         synced_at = now()
       WHERE steam_id = $1`,
      [
        steamId,
        profile.personaName || null,
        profile.customUrl || null,
        profile.summary || null,
        profile.memberSince || null,
        Number.isInteger(profile.level) ? profile.level : null,
        Number.isInteger(profile.gameCount) ? profile.gameCount : null,
        Number.isInteger(profile.wishlistCount) ? profile.wishlistCount : null
      ])

    await client.query('COMMIT')
    return {
      newGames: games.filter(g => !knownGames.has(g.appId)).length,
      newReviews: Array.isArray(reviews) ? reviews.filter(r => !knownReviews.has(r.appId)).length : 0
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function getOverview () {
  const rows = await pool.query(
    `SELECT p.steam_id, p.account_ref, p.persona_name, p.custom_url, p.summary, p.member_since, p.level,
            p.game_count, p.wishlist_count, p.synced_at,
            (SELECT count(*)::int FROM steam_games g WHERE g.steam_id = p.steam_id) AS stored_game_count,
            (SELECT count(*)::int FROM steam_reviews r WHERE r.steam_id = p.steam_id) AS review_count,
            (SELECT count(*)::int FROM steam_wishlist w WHERE w.steam_id = p.steam_id) AS stored_wishlist_count
     FROM steam_profiles p
     ORDER BY p.account_ref`)
  return rows.rows
}

async function getGames (limit = 1000) {
  const rows = await pool.query(
    `SELECT g.steam_id, p.account_ref, p.persona_name, p.custom_url,
            g.app_id, g.name, g.name_en, g.playtime_hours, g.recent_hours, g.first_played_at, g.last_played_at
     FROM steam_games g JOIN steam_profiles p ON p.steam_id = g.steam_id
     ORDER BY g.playtime_hours DESC NULLS LAST, g.app_id ASC LIMIT $1`, [limit])
  return rows.rows
}

async function getReviews (limit = 500) {
  const rows = await pool.query(
    `SELECT r.steam_id, p.account_ref, p.persona_name, p.custom_url,
            r.app_id, COALESCE(r.name, g.name) AS name, g.name_en, r.recommended, r.hours_on_record, r.posted, r.content, r.url, r.position
     FROM steam_reviews r
     JOIN steam_profiles p ON p.steam_id = r.steam_id
     LEFT JOIN steam_games g ON g.steam_id = r.steam_id AND g.app_id = r.app_id
     ORDER BY r.position ASC LIMIT $1`, [limit])
  return rows.rows
}

async function getWishlist (limit = 2000) {
  const rows = await pool.query(
    `SELECT w.steam_id, p.account_ref, p.persona_name, p.custom_url,
            w.app_id, w.name, w.name_en, w.priority, w.added_at
     FROM steam_wishlist w JOIN steam_profiles p ON p.steam_id = w.steam_id
     ORDER BY w.added_at DESC NULLS LAST, w.priority ASC NULLS LAST, w.app_id ASC LIMIT $1`, [limit])
  return rows.rows
}

module.exports = { setProfiles, listProfiles, knownApps, saveApps, saveAccountData, getOverview, getGames, getReviews, getWishlist }
