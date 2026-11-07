// Video summaries asked for with /youtube summarize go to Gemini's Batch API: half the price of
// asking one by one, in exchange for waiting (Gemini aims to be done within 24 hours, usually much
// sooner). The batch is kept in the database (summaryBatches.js) and looked at every few minutes
// by one worker; when it is done the summaries are stored and the channel the command was used in
// is told. A video too long for one request is then summarized the usual way, in parts.
// VIDEO_SUMMARY_BATCH=false summarizes right away instead, as before.
const { geminiRequest, geminiSend, GeminiError } = require('./eventDrafter')
const videoSummary = require('./videoSummary')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const store = require('../../db/interfaces/postgres/summaryBatches')
const { recordTokens } = require('../utils/geminiUsage')
const { linkTimestamps } = require('../utils/youtube')

const POLL_EVERY_MS = 5 * 60 * 1000
const MAX_SHOWN_SUMMARY = 1500

function enabled () {
  return process.env.VIDEO_SUMMARY_BATCH !== 'false'
}

// Videos not worth waiting a day for are summarized at once instead, on Flex inference (half the
// price too, queued for minutes at most): the newest video of each channel, and short ones (at
// most VIDEO_SUMMARY_FLEX_SECONDS long, default 300: Shorts and clips).
const DEFAULT_SHORT_SECONDS = 300
function shortSeconds () {
  const n = Number(process.env.VIDEO_SUMMARY_FLEX_SECONDS)
  return process.env.VIDEO_SUMMARY_FLEX_SECONDS && Number.isFinite(n) && n >= 0 ? n : DEFAULT_SHORT_SECONDS
}

// Which of `videoIDs` are summarized at once (a Set).
async function quickVideoIDs (guildID, videoIDs) {
  const knowledge = await youtubeDB.getKnowledge(guildID).catch(() => null)
  const newest = new Set()
  const seen = new Set()
  for (const v of knowledge?.videos || []) { // newest first
    if (['live', 'upcoming'].includes(v.live_status) || seen.has(v.channel_id)) continue
    seen.add(v.channel_id)
    newest.add(v.video_id)
  }
  const quick = new Set()
  for (const id of videoIDs) {
    if (newest.has(id)) {
      quick.add(id)
      continue
    }
    const seconds = await videoSummary.lengthOf(id).catch(() => null)
    if (seconds && seconds <= shortSeconds()) quick.add(id)
  }
  return quick
}

// Sends the videos as one batch. Resolves to the batch's name.
async function submit (guildID, videoIDs, { channelID = null, requesterID = null } = {}) {
  const requests = videoIDs.map(id => ({ id, ...videoSummary.summaryRequest(id) }))
  const model = requests[0].model
  const data = await geminiRequest(model, 'batchGenerateContent', {
    batch: {
      display_name: `robopolice-summaries-${guildID}-${Date.now()}`,
      input_config: { requests: { requests: requests.map(r => ({ request: r.body, metadata: { key: r.id } })) } }
    }
  }, { purpose: 'videoSummary-batch', timeoutMs: 60 * 1000 })
  const name = data.name || data.metadata?.name
  if (!/^batches\//.test(name || '')) throw new GeminiError(`Gemini returned no batch name: ${JSON.stringify(data).slice(0, 300)}`, 'AI に要約をまとめて依頼できませんでした')
  await store.saveBatch({ name, guildID, channelID, requesterID, videoIDs, model })
  return name
}

// The batch's state (BATCH_STATE_… or JOB_STATE_…) and its results, wherever Gemini puts them.
function stateOf (data) {
  return String(data.metadata?.state || data.state || '')
}
function resultsOf (data) {
  return data.response?.inlinedResponses?.inlinedResponses ||
    data.metadata?.output?.inlinedResponses?.inlinedResponses ||
    data.dest?.inlinedResponses?.inlinedResponses ||
    data.dest?.inlinedResponses ||
    []
}

// Stores what a finished batch made. Resolves to [{ videoID, summary, error }] in the batch's order.
async function collect (batch, data) {
  const byKey = new Map(resultsOf(data).map(r => [r.metadata?.key, r]))
  const results = []
  for (const videoID of batch.video_ids) {
    const r = byKey.get(videoID)
    try {
      const failure = r?.error?.message || (r ? null : 'no result')
      if (failure) {
        // Too long for one request: in parts, the usual way.
        if (!videoSummary.TOO_LONG.test(failure)) throw new GeminiError(`Batch summary of ${videoID} failed: ${failure}`, `AI が要約できませんでした（${failure.slice(0, 100)}）`)
        const { summary } = await videoSummary.summarizeVideo(batch.guild_id, `https://www.youtube.com/watch?v=${videoID}`, { force: true, flex: true })
        results.push({ videoID, summary, error: null })
        continue
      }
      recordTokens('videoSummary-batch', batch.model, r.response?.usageMetadata)
      const content = r.response?.candidates?.[0]?.content
      const summary = await videoSummary.storeSummary(batch.guild_id, videoID, content ? videoSummary.textOf(content) : '')
      results.push({ videoID, summary, error: null })
    } catch (e) {
      results.push({ videoID, summary: null, error: e.hint || e.message })
    }
  }
  return results
}

// What the channel is told when the batch is done.
function report (batch, results, failed = null) {
  const who = batch.requester_id ? `<@${batch.requester_id}> ` : ''
  if (failed) return `${who}動画の要約（まとめて依頼した ${batch.video_ids.length} 本）はできませんでした: ${failed}`
  const ok = results.filter(r => !r.error)
  if (results.length === 1 && ok.length === 1) {
    const { videoID, summary } = ok[0]
    const text = linkTimestamps(summary.length > MAX_SHOWN_SUMMARY ? `${summary.slice(0, MAX_SHOWN_SUMMARY)}…` : summary, videoID)
    return `${who}動画を要約しました。メンションで依頼したときに AI が参照します。\nhttps://www.youtube.com/watch?v=${videoID}\n${text}`.slice(0, 2000)
  }
  const lines = [
    `${who}${ok.length}/${results.length} 本の動画を要約しました。メンションで依頼したときに AI が参照します。`,
    ...results.filter(r => r.error).map(r => `⚠️ https://youtu.be/${r.videoID} : ${r.error}`),
    ...ok.map(r => `✅ <https://youtu.be/${r.videoID}>`)
  ]
  let text = ''
  for (const line of lines) {
    if ((text + line).length > 1900) return `${text}…`
    text += `${text ? '\n' : ''}${line}`
  }
  return text
}

async function tell (batch, content) {
  if (!batch.channel_id) return
  await global.bot.createMessage(batch.channel_id, { content, allowedMentions: { users: batch.requester_id ? [batch.requester_id] : [] } })
    .catch(e => global.logger.warn(`[SUMMARY]: Could not say batch ${batch.name} is done in ${batch.channel_id}: ${e.message}`))
}

// Looks at one batch; stores and reports it when it is done. Resolves to whether it is done.
// Gemini keeps a batch for 48 hours: one that still cannot be read after MAX_BATCH_HOURS is given up
// on, and the channel told.
const MAX_BATCH_HOURS = 50
async function check (batch, now = Date.now()) {
  const age = batch.created_at ? (now - new Date(batch.created_at).getTime()) / 3600000 : 0
  let data
  try {
    data = await geminiSend('GET', batch.name)
  } catch (e) {
    if (![400, 403, 404].includes(e.status) && age < MAX_BATCH_HOURS) {
      await store.noteBatch(batch.name, { error: e.message }).catch(() => {})
      throw e
    }
    data = { metadata: { state: 'BATCH_STATE_EXPIRED' } }
  }
  const state = stateOf(data)
  if (/SUCCEEDED/.test(state)) {
    const results = await collect(batch, data)
    await tell(batch, report(batch, results))
    global.logger.info(`[SUMMARY]: Batch ${batch.name} done: ${results.filter(r => !r.error).length}/${results.length} summarized`)
  } else if (/FAILED|CANCELLED|EXPIRED/.test(state)) {
    await tell(batch, report(batch, [], `Gemini の処理が ${state.replace(/^(BATCH|JOB)_STATE_/, '').toLowerCase()} で終わりました`))
    global.logger.warn(`[SUMMARY]: Batch ${batch.name} ended ${state}: ${JSON.stringify(data.error || data.metadata?.error || '').slice(0, 300)}`)
  } else if (age >= MAX_BATCH_HOURS) {
    await geminiSend('POST', `${batch.name}:cancel`).catch(() => {})
    await tell(batch, report(batch, [], `Gemini の処理が ${Math.round(age)} 時間たっても終わりませんでした`))
    global.logger.warn(`[SUMMARY]: Batch ${batch.name} still ${state || 'unknown'} after ${Math.round(age)} h; given up on`)
  } else {
    await store.noteBatch(batch.name, { state: state || 'unknown' }).catch(() => {})
    return false
  }
  await store.deleteBatch(batch.name)
  return true
}

let checking = false
async function checkAll () {
  if (checking) return
  checking = true
  try {
    for (const batch of await store.runningBatches()) {
      await check(batch).catch(e => global.logger.warn(`[SUMMARY]: Could not check batch ${batch.name}: ${e.message}`))
    }
  } finally {
    checking = false
  }
}

function startBatchWatcher () {
  setTimeout(checkAll, 60 * 1000)
  setInterval(checkAll, POLL_EVERY_MS)
}

// The batches of the server still running.
function running (guildID) {
  return store.runningBatches(guildID)
}

module.exports = { enabled, quickVideoIDs, submit, running, check, checkAll, collect, report, stateOf, resultsOf, startBatchWatcher }
