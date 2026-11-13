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
// is read. App titles are kept once in steam_apps. Resolves to { newGames, newReviews }.
async function saveAccountData (steamId, { profile = {}, games = [], reviews = null, wishlist = null } = {}) {
  const client = await pool.getPostgresClient()
  try {
    await client.query('BEGIN')
    const knownGames = new Set((await client.query('SELECT app_id FROM steam_games WHERE steam_id = $1 AND owned', [steamId])).rows.map(r => r.app_id))
    const knownReviews = new Set((await client.query('SELECT app_id FROM steam_games WHERE steam_id = $1 AND review_content IS NOT NULL', [steamId])).rows.map(r => r.app_id))

    const appsById = new Map()
    for (const item of [...games, ...(Array.isArray(wishlist) ? wishlist : []), ...(Array.isArray(reviews) ? reviews : [])]) {
      if (!item?.appId) continue
      const prev = appsById.get(item.appId)
      const name = item.name || prev?.name || `App ${item.appId}`
      const nameEn = item.nameEn || prev?.nameEn || null
      appsById.set(item.appId, { appId: item.appId, name, nameEn })
    }
    for (const a of appsById.values()) {
      await client.query(
        `INSERT INTO steam_apps (app_id, name, name_en) VALUES ($1, $2, $3)
         ON CONFLICT (app_id) DO UPDATE SET
           name = CASE WHEN $2 LIKE 'App %' AND steam_apps.name NOT LIKE 'App %' THEN steam_apps.name ELSE $2 END,
           name_en = COALESCE($3, steam_apps.name_en)`,
        [a.appId, a.name, a.nameEn])
    }

    for (const g of games) {
      await client.query(
        `INSERT INTO steam_games (steam_id, app_id, owned, playtime_hours, recent_hours, first_played_at, last_played_at)
         VALUES ($1, $2, true, $3, $4, $5, $6)
         ON CONFLICT (steam_id, app_id) DO UPDATE SET
           owned = true,
           playtime_hours = CASE
             WHEN $3::real IS NULL THEN steam_games.playtime_hours
             WHEN steam_games.playtime_hours IS NULL THEN $3::real
             ELSE GREATEST(steam_games.playtime_hours, $3::real)
           END,
           recent_hours = $4,
           first_played_at = COALESCE($5, steam_games.first_played_at),
           last_played_at = COALESCE($6, steam_games.last_played_at)`,
        [
          steamId,
          g.appId,
          Number.isFinite(g.playtimeHours) ? g.playtimeHours : null,
          Number.isFinite(g.recentHours) ? g.recentHours : null,
          g.firstPlayedAt || null,
          g.lastPlayedAt || null
        ])
    }

    if (Array.isArray(reviews)) {
      for (const [position, r] of reviews.entries()) {
        await client.query(
          `INSERT INTO steam_games (
             steam_id, app_id, owned,
             review_recommended, review_hours, review_posted, review_content, review_url, review_position
           )
           VALUES ($1, $2, false, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (steam_id, app_id) DO UPDATE SET
             review_recommended = $3,
             review_hours = COALESCE($4, steam_games.review_hours),
             review_posted = COALESCE($5, steam_games.review_posted),
             review_content = $6,
             review_url = $7,
             review_position = $8`,
          [
            steamId,
            r.appId,
            Boolean(r.recommended),
            Number.isFinite(r.hoursOnRecord) ? r.hoursOnRecord : null,
            r.posted || null,
            r.content,
            r.url,
            position
          ])
      }
      if (reviews.length) {
        const keepIds = reviews.map(r => r.appId)
        await client.query(
          'DELETE FROM steam_games WHERE steam_id = $1 AND NOT owned AND NOT wishlisted AND NOT (app_id = ANY($2::int[]))',
          [steamId, keepIds])
        await client.query(
          `UPDATE steam_games SET
             review_recommended = NULL,
             review_hours = NULL,
             review_posted = NULL,
             review_content = NULL,
             review_url = NULL,
             review_position = NULL
           WHERE steam_id = $1 AND review_content IS NOT NULL AND NOT (app_id = ANY($2::int[]))`,
          [steamId, keepIds])
      }
    }

    if (Array.isArray(wishlist)) {
      for (const w of wishlist) {
        await client.query(
          `INSERT INTO steam_games (steam_id, app_id, owned, wishlisted, wishlist_priority, wishlisted_at)
           VALUES ($1, $2, false, true, $3, $4)
           ON CONFLICT (steam_id, app_id) DO UPDATE SET
             wishlisted = true,
             wishlist_priority = $3,
             wishlisted_at = COALESCE($4, steam_games.wishlisted_at)`,
          [
            steamId,
            w.appId,
            Number.isInteger(w.priority) ? w.priority : null,
            w.addedAt || null
          ])
      }
      if (wishlist.length) {
        const keepIds = wishlist.map(w => w.appId)
        await client.query(
          'DELETE FROM steam_games WHERE steam_id = $1 AND NOT owned AND review_content IS NULL AND NOT (app_id = ANY($2::int[]))',
          [steamId, keepIds])
        await client.query(
          `UPDATE steam_games SET
             wishlisted = false,
             wishlist_priority = NULL,
             wishlisted_at = NULL
           WHERE steam_id = $1 AND wishlisted AND NOT (app_id = ANY($2::int[]))`,
          [steamId, keepIds])
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
            (SELECT count(*)::int FROM steam_games g WHERE g.steam_id = p.steam_id AND g.owned) AS stored_game_count,
            (SELECT count(*)::int FROM steam_games g WHERE g.steam_id = p.steam_id AND g.review_content IS NOT NULL) AS review_count,
            (SELECT count(*)::int FROM steam_games g WHERE g.steam_id = p.steam_id AND g.wishlisted) AS stored_wishlist_count
     FROM steam_profiles p
     ORDER BY p.account_ref`)
  return rows.rows
}

async function getGames (limit = 1000) {
  const rows = await pool.query(
    `SELECT g.steam_id, p.account_ref, p.persona_name, p.custom_url,
            g.app_id, a.name, a.name_en, g.playtime_hours, g.recent_hours, g.first_played_at, g.last_played_at
     FROM steam_games g
     JOIN steam_profiles p ON p.steam_id = g.steam_id
     JOIN steam_apps a ON a.app_id = g.app_id
     WHERE g.owned
     ORDER BY g.playtime_hours DESC NULLS LAST, g.app_id ASC LIMIT $1`, [limit])
  return rows.rows
}

async function getReviews (limit = 500) {
  const rows = await pool.query(
    `SELECT g.steam_id, p.account_ref, p.persona_name, p.custom_url,
            g.app_id, a.name, a.name_en,
            g.review_recommended AS recommended,
            g.review_hours AS hours_on_record,
            g.review_posted AS posted,
            g.review_content AS content,
            g.review_url AS url,
            g.review_position AS position
     FROM steam_games g
     JOIN steam_profiles p ON p.steam_id = g.steam_id
     JOIN steam_apps a ON a.app_id = g.app_id
     WHERE g.review_content IS NOT NULL
     ORDER BY g.review_position ASC LIMIT $1`, [limit])
  return rows.rows
}

async function getWishlist (limit = 2000) {
  const rows = await pool.query(
    `SELECT g.steam_id, p.account_ref, p.persona_name, p.custom_url,
            g.app_id, a.name, a.name_en,
            g.wishlist_priority AS priority,
            g.wishlisted_at AS added_at
     FROM steam_games g
     JOIN steam_profiles p ON p.steam_id = g.steam_id
     JOIN steam_apps a ON a.app_id = g.app_id
     WHERE g.wishlisted
     ORDER BY g.wishlisted_at DESC NULLS LAST, g.wishlist_priority ASC NULLS LAST, g.app_id ASC LIMIT $1`, [limit])
  return rows.rows
}

module.exports = { setProfiles, listProfiles, knownApps, saveApps, saveAccountData, getOverview, getGames, getReviews, getWishlist }
