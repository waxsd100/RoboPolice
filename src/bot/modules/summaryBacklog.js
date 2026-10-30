// Summarizes the stored videos that have no summary yet, a little every day, newest first, within
// a budget: first on a free-tier key (the Gemini free tier allows 8 hours of YouTube video a day
// per project), then on the usual paid key up to a monthly number of hours. One worker runs it for
// all servers, like the retention sweep.
//
//   VIDEO_SUMMARY_FREE_BYOK_ALIAS        Name of a free-tier project's key stored in AI Gateway.
//   YOUTUBE_SUMMARY_FREE_HOURS_PER_DAY   Hours of video a day on it (default 8 when the alias is set).
//   YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH Hours of video a month on the usual key (default 0: none).
//
// Usage is counted by video length, which is what the free tier limits and what the cost follows.
// The free tier's day starts at midnight Pacific time; the paid month is the calendar month in Japan.
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { summarizeVideo } = require('./videoSummary')
const { isGatewayConfigured } = require('../utils/aiGateway')

const TICK_MS = 10 * 60 * 1000
const PER_TICK = 6 // each is a long call; a tick does a few, the next tick continues
const MAX_ATTEMPTS = 2
const DEFAULT_FREE_HOURS = 8

function settings () {
  const freeAlias = process.env.VIDEO_SUMMARY_FREE_BYOK_ALIAS || null
  const hours = (name, fallback) => {
    const value = Number(process.env[name])
    return process.env[name] && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  return {
    freeAlias,
    freeSeconds: freeAlias ? hours('YOUTUBE_SUMMARY_FREE_HOURS_PER_DAY', DEFAULT_FREE_HOURS) * 3600 : 0,
    paidSeconds: hours('YOUTUBE_SUMMARY_PAID_HOURS_PER_MONTH', 0) * 3600
  }
}

// ISO 8601 durations as YouTube gives them (PT1H2M3S, P1DT2H): seconds, or null.
function durationSeconds (iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const [, d, h, min, s] = m.map(v => Number(v || 0))
  return d * 86400 + h * 3600 + min * 60 + s
}

const dateIn = (timeZone, date) => new Intl.DateTimeFormat('sv-SE', { timeZone }).format(date)
const freeDay = now => dateIn('America/Los_Angeles', now)
const paidMonth = now => {
  const today = dateIn('Asia/Tokyo', now)
  return { first: `${today.slice(0, 7)}-01`, today }
}

// Which key a video of `seconds` can go on now: 'free', 'paid', or null when both budgets are spent.
async function tierFor (seconds, config, now, exhausted) {
  if (config.freeAlias && !exhausted.has('free')) {
    const used = await youtubeDB.summaryUsage('free', freeDay(now))
    if (used + seconds <= config.freeSeconds) return 'free'
  }
  if (config.paidSeconds) {
    const { first, today } = paidMonth(now)
    const used = await youtubeDB.summaryUsage('paid', first, today)
    if (used + seconds <= config.paidSeconds) return 'paid'
  }
  return null
}

const isRateLimit = e => /HTTP 429/.test(e?.message || '')

// One pass: summarizes up to PER_TICK videos within the budgets. Resolves to { done, failed }.
async function runOnce (now = new Date()) {
  const config = settings()
  if (!config.freeSeconds && !config.paidSeconds) return { done: 0, failed: 0 }
  const exhausted = new Set()
  const keys = [config.freeSeconds && 'free', config.paidSeconds && 'paid'].filter(Boolean)
  let done = 0
  let failed = 0
  for (const video of await youtubeDB.videosForSummaryBacklog(PER_TICK * 3, MAX_ATTEMPTS)) {
    if (done + failed >= PER_TICK) break
    const seconds = durationSeconds(video.duration)
    if (!seconds) continue
    // A key that hits its own rate limit is set aside and the same video tried on the other.
    let tier = await tierFor(seconds, config, now, exhausted)
    while (tier) {
      try {
        await summarizeVideo(video.guild_id, video.url, { byokAlias: tier === 'free' ? config.freeAlias : null })
        await youtubeDB.addSummaryUsage(tier, tier === 'free' ? freeDay(now) : paidMonth(now).today, seconds)
        done++
        break
      } catch (e) {
        if (!isRateLimit(e)) {
          await youtubeDB.recordSummaryFailure(video.guild_id, video.video_id, e.hint || e.message)
          failed++
          break
        }
        exhausted.add(tier)
        tier = await tierFor(seconds, config, now, exhausted)
      }
    }
    // Every key rate limited: try again next pass. (A video too long for what is left of a budget
    // is just skipped: a shorter one may still fit.)
    if (keys.every(k => exhausted.has(k))) break
  }
  if (done || failed) global.logger.info(`[SUMMARIES]: Summarized ${done} video(s) from the backlog, ${failed} failed`)
  return { done, failed }
}

let running = false
async function tick () {
  if (running) return
  running = true
  try {
    await runOnce()
  } catch (e) {
    global.logger.warn(`[SUMMARIES]: Backlog pass failed: ${e.message}`)
  } finally {
    running = false
  }
}

function startBacklog () {
  const config = settings()
  if (!isGatewayConfigured() || (!config.freeSeconds && !config.paidSeconds)) return null
  global.logger.startup(`[SUMMARIES]: Summarizing the video backlog: ${config.freeSeconds / 3600} h/day free, ${config.paidSeconds / 3600} h/month paid.`)
  tick()
  return setInterval(tick, TICK_MS)
}

module.exports = { startBacklog, runOnce, durationSeconds, settings, freeDay, paidMonth, MAX_ATTEMPTS }
