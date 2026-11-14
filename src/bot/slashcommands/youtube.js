const { EMBED_COLORS } = require('../utils/constants')
const { parseVideoId, linkTimestamps } = require('../utils/youtube')
const { sync, videosToSummarize, summarizeLatest } = require('../modules/youtubeSync')
const { summarizeVideo } = require('../modules/videoSummary')
const summaryBatch = require('../modules/summaryBatch')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { isOwnerGuild } = require('../utils/priority')
const { redact } = require('../utils/redact')
const { langOf } = require('../utils/i18n')

// What the command says, in Japanese or English (by the client's language). What comes from the
// modules (sync notes, errors) is as they give it.
const TEXT = {
  ja: {
    live: { live: '配信中', upcoming: '配信予定' },
    notSynced: '未取得',
    channelLine: (name, videos, summarized, synced) => `・${name}: 動画 ${videos} 件（要約あり ${summarized} 件）、最終取得 ${synced}`,
    title: 'BOT が見ている YouTube チャンネル',
    storedVideos: '保存している動画',
    storedCount: (videos, summarized) => `${videos} 件（内容の要約あり ${summarized} 件）`,
    liveEvents: '配信・新着動画のイベント登録',
    on: '有効',
    off: '無効（`/youtube liveevents enabled:True`）',
    streams: '配信',
    footer: 'チャンネルは BOT 共通です（YOUTUBE_CHANNELS で設定）',
    noManageEvents: 'BOT に「イベントの管理」権限がないため、配信をイベントに登録できません。権限を付けてからもう一度お試しください。',
    eventsOn: 'これから始まる配信と配信予定の枠、新しく投稿された動画を、サーバーのイベントとして自動で登録します。配信はイベントも始まり・終わりが連動し、新着動画は投稿から24時間イベントにします。',
    eventsOff: '配信・新着動画のイベント登録をやめました。登録済みのイベントはそのまま残ります。',
    batchRunning: '前にまとめて依頼した要約がまだ終わっていません。終わってからもう一度お試しください（終わるとこのチャンネルでお知らせします）。',
    batchSent: n => `${n} 本の動画の要約を、AI にまとめて依頼しました（Batch API: 料金は半分で、終わるまで数分〜最大24時間かかります）。終わったらこのチャンネルでお知らせします。`,
    badLink: 'YouTube の動画リンク（https://www.youtube.com/watch?v=… や https://youtu.be/…）を指定してください。',
    busy: '別の要約を実行中です。終わってからもう一度お試しください。',
    summarizingOne: '動画の内容を要約しています…\n長い動画は数分かかります。',
    cached: '保存済みの要約です（`force:True` で要約し直せます）。',
    done: force => `${force ? '要約し直しました' : '要約しました'}。メンションで依頼したときに AI が参照します。`,
    nothingForced: '要約できる動画がありません（配信中・配信予定のものは除きます）。',
    nothing: '要約していない動画はありません（配信中・配信予定のものは除きます）。`force:True` で要約し直せます。',
    progress: (done, total, running) => `動画の内容を要約しています（完了 ${done}/${total}、${running} 本を同時に処理中）`,
    slow: '長い動画は1本で数分かかります。',
    doneMany: (ok, all, force) => `${ok}/${all} 本の動画を${force ? '要約し直しました' : '要約しました'}。メンションで依頼したときに AI が参照します。`,
    more: n => `…ほか ${n} 本`,
    noKey: 'YOUTUBE_API_KEY が設定されていないため使えません。',
    noChannels: 'BOT が見ている YouTube チャンネルがありません（環境変数 `YOUTUBE_CHANNELS` で設定します）。',
    ownerOnly: 'チャンネルは BOT 共通のため、取得し直しはオーナーのサーバーからのみできます（新しい動画は自動で取得されます）。',
    synced: note => `最新の情報を取得しました。${note}`,
    failed: why => `YouTube の情報を取得できませんでした: ${why}`
  },
  en: {
    live: { live: 'Live', upcoming: 'Upcoming' },
    notSynced: 'never',
    channelLine: (name, videos, summarized, synced) => `・${name}: ${videos} videos (${summarized} summarized), last read ${synced}`,
    title: 'The YouTube channels the bot follows',
    storedVideos: 'Videos stored',
    storedCount: (videos, summarized) => `${videos} (${summarized} summarized)`,
    liveEvents: 'Streams and uploads as events',
    on: 'On',
    off: 'Off (`/youtube liveevents enabled:True`)',
    streams: 'Streams',
    footer: 'The channels are the same for every server (YOUTUBE_CHANNELS)',
    noManageEvents: 'The bot does not have Manage Events, so it cannot make events for streams. Give it the permission and try again.',
    eventsOn: 'Upcoming and scheduled streams and new uploads will be made server events automatically. A stream\'s event starts and ends with it; a new upload\'s lasts 24 hours.',
    eventsOff: 'Streams and uploads are no longer made events. Events already made stay.',
    batchRunning: 'The summaries asked for before are not done yet. Try again once they are (this channel is told).',
    batchSent: n => `Asked the AI to summarize ${n} video(s) together (Batch API: half the price, minutes to at most 24 hours). This channel is told when they are done.`,
    badLink: 'Give a YouTube video link (https://www.youtube.com/watch?v=… or https://youtu.be/…).',
    busy: 'Another summary is running. Try again once it is done.',
    summarizingOne: 'Summarizing the video…\nA long video takes a few minutes.',
    cached: 'The stored summary (`force:True` to summarize again).',
    done: force => `${force ? 'Summarized again' : 'Summarized'}. The AI reads it when asked in a mention.`,
    nothingForced: 'No video to summarize (streams that are live or upcoming are left out).',
    nothing: 'Every video is summarized (streams that are live or upcoming are left out). `force:True` summarizes again.',
    progress: (done, total, running) => `Summarizing the videos (${done}/${total} done, ${running} at a time)`,
    slow: 'A long video takes a few minutes.',
    doneMany: (ok, all, force) => `${force ? 'Summarized again' : 'Summarized'} ${ok}/${all} video(s). The AI reads them when asked in a mention.`,
    more: n => `…and ${n} more`,
    noKey: 'Not available: YOUTUBE_API_KEY is not set.',
    noChannels: 'The bot follows no YouTube channel (set them with `YOUTUBE_CHANNELS`).',
    ownerOnly: 'The channels are the bot\'s, so they can only be read again from the owner\'s servers (new videos are read automatically).',
    synced: note => `Read the latest.${note ? ` ${note}` : ''}`,
    failed: why => `Could not read YouTube: ${why}`
  }
}
const textOf = interaction => TEXT[langOf(interaction)]

// The channels the bot follows (the same for every server) and this server's setting.
function summary ({ channels, videos, live_events: liveEvents }, text = TEXT.ja) {
  const lives = videos.filter(v => text.live[v.live_status])
  const lines = channels.map(c => {
    const count = videos.filter(v => v.channel_id === c.channel_id)
    const synced = c.synced_at ? `<t:${Math.floor(new Date(c.synced_at) / 1000)}:R>` : text.notSynced
    return text.channelLine(c.url ? `[${c.title || c.channel_ref}](<${c.url}>)` : (c.title || c.channel_ref), count.length, count.filter(v => v.summary).length, synced)
  })
  return {
    title: text.title,
    description: lines.join('\n').slice(0, 4000),
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: text.storedVideos, value: text.storedCount(videos.length, videos.filter(v => v.summary).length), inline: true },
      { name: text.liveEvents, value: liveEvents ? text.on : text.off, inline: true },
      ...(lives.length ? [{ name: text.streams, value: lives.slice(0, 5).map(v => `${text.live[v.live_status]}: [${v.title}](${v.url})`).join('\n') }] : [])
    ],
    footer: { text: text.footer }
  }
}

// Turns stream events on or off (src/bot/modules/liveWatcher.js).
async function liveEvents (interaction, sub) {
  const enabled = sub.options?.find(o => o.name === 'enabled')?.value === true
  const guild = global.bot.guilds.get(interaction.guildID)
  if (enabled && !guild?.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    return { content: textOf(interaction).noManageEvents }
  }
  await youtubeDB.setLiveEvents(interaction.guildID, enabled)
  return {
    content: enabled ? textOf(interaction).eventsOn : textOf(interaction).eventsOff
  }
}

const DEFAULT_SUMMARIES = 3
// One bulk summary at a time per server: each is several long Gemini calls.
const summarizing = new Set()

// Summarizes the newest videos that have none. Each can take minutes, longer than an interaction
// can be edited (15 minutes), so the result also goes to the channel if the edit fails.
const MAX_SHOWN_SUMMARY = 1500

// Edits the interaction's reply, or posts in the channel once the reply can no longer be edited.
async function finish (interaction, content) {
  const edited = await interaction.editOriginalMessage({ content }).then(() => true, () => false)
  if (!edited && interaction.channel?.id) await global.bot.createMessage(interaction.channel.id, { content }).catch(() => {})
}

// Sends the videos to Gemini's Batch API (summaryBatch.js): half the price, and the channel is told
// when they are done (minutes to at most a day later).
async function summarizeInBatch (interaction, videoIDs) {
  const guildID = interaction.guildID
  if ((await summaryBatch.running(guildID)).length) return { content: textOf(interaction).batchRunning }
  await summaryBatch.submit(guildID, videoIDs, { channelID: interaction.channel?.id || interaction.channelID, requesterID: interaction.member?.id })
  return { content: textOf(interaction).batchSent(videoIDs.length) }
}

// One video by its link, which may be from any public channel. Shows the summary.
async function summarizeOne (interaction, url, force) {
  const guildID = interaction.guildID
  const text = textOf(interaction)
  const parsedID = parseVideoId(url)
  if (!parsedID) return { content: text.badLink }
  if (summarizing.has(guildID)) return { content: text.busy }
  summarizing.add(guildID)
  try {
    if (!force && typeof youtubeDB.videosInSummaryBatch === 'function') {
      const inBatch = await youtubeDB.videosInSummaryBatch([parsedID])
      if (inBatch?.has(parsedID)) return { content: text.batchRunning }
    }
    // A stored summary is shown at once; a new one goes in a batch, unless it is a channel's newest or a
    // short video: those are summarized at once on Flex inference.
    let flex = false
    if (summaryBatch.enabled() && (force || !await youtubeDB.getSummary(parsedID))) {
      if (!(await summaryBatch.quickVideoIDs(guildID, [parsedID])).has(parsedID)) return await summarizeInBatch(interaction, [parsedID])
      flex = true
    }
    const { videoID, summary, cached } = await summarizeVideo(guildID, url, {
      force,
      flex,
      onStart: () => interaction.editOriginalMessage({ content: text.summarizingOne }).catch(() => {})
    })
    const head = cached ? text.cached : text.done(force)
    const shown = linkTimestamps(summary.length > MAX_SHOWN_SUMMARY ? `${summary.slice(0, MAX_SHOWN_SUMMARY)}…` : summary, videoID)
    await finish(interaction, `${head}\nhttps://www.youtube.com/watch?v=${videoID}\n${shown}`.slice(0, 2000))
    return null
  } finally {
    summarizing.delete(guildID)
  }
}

async function summarize (interaction, sub) {
  const count = sub.options?.find(o => o.name === 'count')?.value || DEFAULT_SUMMARIES
  // force: the newest videos whether or not they were summarized, replacing what is stored.
  const force = sub.options?.find(o => o.name === 'force')?.value === true
  const url = sub.options?.find(o => o.name === 'url')?.value
  if (url) return summarizeOne(interaction, url.trim(), force)
  const text = textOf(interaction)
  const guildID = interaction.guildID
  if (summarizing.has(guildID)) return { content: text.busy }
  summarizing.add(guildID)
  try {
    let videos = await videosToSummarize(guildID, count, { force })
    if (videos.length === 0) {
      return { content: force ? text.nothingForced : text.nothing }
    }
    // With batches: each channel's newest and short videos are summarized at once on Flex inference,
    // the rest go in a batch.
    let flex = false
    let note = ''
    if (summaryBatch.enabled()) {
      const quick = await summaryBatch.quickVideoIDs(guildID, videos.map(v => v.video_id))
      const later = videos.filter(v => !quick.has(v.video_id))
      videos = videos.filter(v => quick.has(v.video_id))
      if (later.length) note = (await summarizeInBatch(interaction, later.map(v => v.video_id))).content
      if (videos.length === 0) return { content: note }
      flex = true
      if (note) await interaction.editOriginalMessage({ content: note }).catch(() => {})
    }
    const results = await summarizeLatest(guildID, videos, {
      force,
      flex,
      onProgress: ({ done, total, running }) => interaction.editOriginalMessage({
        content: [
          text.progress(done, total, running.length),
          // Linked (with Discord's preview turned off, so the progress message stays small), with
          // the video's ID.
          ...running.map(v => `・[${String(v.title).replace(/[[\]]/g, '')}](<${v.url}>)（ID: \`${v.video_id}\`）`),
          text.slow
        ].join('\n').slice(0, 2000)
      }).catch(() => {})
    })
    const head = text.doneMany(results.filter(r => !r.error).length, results.length, force)
    // Failures first: with many videos, not every line fits in one message.
    const lines = [
      ...results.filter(r => r.error).map(({ video, error }) => `⚠️ [${video.title}](<${video.url}>)（ID: \`${video.video_id}\`）: ${error}`),
      ...results.filter(r => !r.error).map(({ video }) => `✅ [${video.title}](<${video.url}>)`)
    ]
    await finish(interaction, fitLines(note ? `${note}\n${head}` : head, lines, 2000, text.more))
    return null
  } finally {
    summarizing.delete(guildID)
  }
}

// `head` and as many of `lines` as fit in one message, then how many were left out.
function fitLines (head, lines, max = 2000, more = TEXT.ja.more) {
  const shown = []
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1
    const tail = rest ? `\n${more(rest)}` : ''
    if ([head, ...shown, line].join('\n').length + tail.length > max) {
      return `${[head, ...shown].join('\n')}\n${more(lines.length - i)}`
    }
    shown.push(line)
  }
  return [head, ...shown].join('\n')
}

async function run (interaction) {
  const [sub] = interaction.data.options
  const text = textOf(interaction)
  if (!process.env.YOUTUBE_API_KEY) {
    return { content: text.noKey }
  }
  // A video given by its link needs no channel.
  if (sub.name === 'summarize' && sub.options?.some(o => o.name === 'url')) return summarize(interaction, sub)
  const stored = await youtubeDB.getKnowledge(interaction.guildID)
  if (!stored) return { content: text.noChannels }
  if (sub.name === 'sync') {
    // The channels are the bot's: reading them again is for the owner's servers.
    if (!isOwnerGuild(interaction.guildID)) return { content: text.ownerOnly }
    const { knowledge, note } = await sync(interaction.guildID)
    return { content: text.synced(note), embeds: [summary(knowledge, text)] }
  }
  if (sub.name === 'summarize') return summarize(interaction, sub)
  if (sub.name === 'liveevents') return liveEvents(interaction, sub)
  return { embeds: [summary(stored, text)] }
}

module.exports = {
  name: 'youtube',
  userPerms: ['manageGuild'],
  noThread: true,
  func: async interaction => {
    // Syncing calls the YouTube API, which can take longer than the 3s Discord allows for a reply.
    await interaction.defer().catch(() => {})
    let reply
    try {
      reply = await run(interaction)
    } catch (e) {
      global.logger.error(e)
      reply = { content: textOf(interaction).failed(e.hint || redact(e.message).slice(0, 300)), embeds: [], components: [] }
    }
    // summarize answers by itself.
    if (reply) await interaction.editOriginalMessage(reply).catch(() => {})
  }
}
