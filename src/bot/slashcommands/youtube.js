const { EMBED_COLORS } = require('../utils/constants')
const { parseVideoId, linkTimestamps } = require('../utils/youtube')
const { sync, videosToSummarize, summarizeLatest } = require('../modules/youtubeSync')
const { summarizeVideo } = require('../modules/videoSummary')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { isOwnerGuild } = require('../utils/priority')
const { redact } = require('../utils/redact')

const LIVE_LABELS = { live: '配信中', upcoming: '配信予定' }

// The channels the bot follows (the same for every server) and this server's setting.
function summary ({ channels, videos, live_events: liveEvents }) {
  const lives = videos.filter(v => LIVE_LABELS[v.live_status])
  const lines = channels.map(c => {
    const count = videos.filter(v => v.channel_id === c.channel_id)
    const synced = c.synced_at ? `<t:${Math.floor(new Date(c.synced_at) / 1000)}:R>` : '未取得'
    return `・${c.url ? `[${c.title || c.channel_ref}](<${c.url}>)` : (c.title || c.channel_ref)}: 動画 ${count.length} 件（要約あり ${count.filter(v => v.summary).length} 件）、最終取得 ${synced}`
  })
  return {
    title: 'BOT が見ている YouTube チャンネル',
    description: lines.join('\n').slice(0, 4000),
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: '保存している動画', value: `${videos.length} 件（内容の要約あり ${videos.filter(v => v.summary).length} 件）`, inline: true },
      { name: '配信・新着動画のイベント登録', value: liveEvents ? '有効' : '無効（`/youtube liveevents enabled:True`）', inline: true },
      ...(lives.length ? [{ name: '配信', value: lives.slice(0, 5).map(v => `${LIVE_LABELS[v.live_status]}: [${v.title}](${v.url})`).join('\n') }] : [])
    ],
    footer: { text: 'チャンネルは BOT 共通です（YOUTUBE_CHANNELS で設定）' }
  }
}

// Turns stream events on or off (src/bot/modules/liveWatcher.js).
async function liveEvents (interaction, sub) {
  const enabled = sub.options?.find(o => o.name === 'enabled')?.value === true
  const guild = global.bot.guilds.get(interaction.guildID)
  if (enabled && !guild?.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    return { content: 'BOT に「イベントの管理」権限がないため、配信をイベントに登録できません。権限を付けてからもう一度お試しください。' }
  }
  await youtubeDB.setLiveEvents(interaction.guildID, enabled)
  return {
    content: enabled
      ? 'これから始まる配信と配信予定の枠、新しく投稿された動画を、サーバーのイベントとして自動で登録します。配信はイベントも始まり・終わりが連動し、新着動画は投稿から24時間イベントにします。'
      : '配信・新着動画のイベント登録をやめました。登録済みのイベントはそのまま残ります。'
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

// One video by its link, which may be from any public channel. Shows the summary.
async function summarizeOne (interaction, url, force) {
  const guildID = interaction.guildID
  if (!parseVideoId(url)) return { content: 'YouTube の動画リンク（https://www.youtube.com/watch?v=… や https://youtu.be/…）を指定してください。' }
  if (summarizing.has(guildID)) return { content: '別の要約を実行中です。終わってからもう一度お試しください。' }
  summarizing.add(guildID)
  try {
    const { videoID, summary, cached } = await summarizeVideo(guildID, url, {
      force,
      onStart: () => interaction.editOriginalMessage({ content: '動画の内容を要約しています…\n長い動画は数分かかります。' }).catch(() => {})
    })
    const head = cached
      ? '保存済みの要約です（`force:True` で要約し直せます）。'
      : `${force ? '要約し直しました' : '要約しました'}。メンションで依頼したときに AI が参照します。`
    const text = linkTimestamps(summary.length > MAX_SHOWN_SUMMARY ? `${summary.slice(0, MAX_SHOWN_SUMMARY)}…` : summary, videoID)
    await finish(interaction, `${head}\nhttps://www.youtube.com/watch?v=${videoID}\n${text}`.slice(0, 2000))
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
  const guildID = interaction.guildID
  if (summarizing.has(guildID)) return { content: '別の要約を実行中です。終わってからもう一度お試しください。' }
  const videos = await videosToSummarize(guildID, count, { force })
  if (videos.length === 0) {
    return { content: force ? '要約できる動画がありません（配信中・配信予定のものは除きます）。' : '要約していない動画はありません（配信中・配信予定のものは除きます）。`force:True` で要約し直せます。' }
  }
  summarizing.add(guildID)
  try {
    const results = await summarizeLatest(guildID, videos, {
      force,
      onProgress: ({ done, total, running }) => interaction.editOriginalMessage({
        content: [
          `動画の内容を要約しています（完了 ${done}/${total}、${running.length} 本を同時に処理中）`,
          // Linked (with Discord's preview turned off, so the progress message stays small), with
          // the video's ID.
          ...running.map(v => `・[${String(v.title).replace(/[[\]]/g, '')}](<${v.url}>)（ID: \`${v.video_id}\`）`),
          '長い動画は1本で数分かかります。'
        ].join('\n').slice(0, 2000)
      }).catch(() => {})
    })
    const head = `${results.filter(r => !r.error).length}/${results.length} 本の動画を${force ? '要約し直しました' : '要約しました'}。メンションで依頼したときに AI が参照します。`
    // Failures first: with many videos, not every line fits in one message.
    const lines = [
      ...results.filter(r => r.error).map(({ video, error }) => `⚠️ [${video.title}](<${video.url}>)（ID: \`${video.video_id}\`）: ${error}`),
      ...results.filter(r => !r.error).map(({ video }) => `✅ [${video.title}](<${video.url}>)`)
    ]
    await finish(interaction, fitLines(head, lines))
    return null
  } finally {
    summarizing.delete(guildID)
  }
}

// `head` and as many of `lines` as fit in one message, then how many were left out.
function fitLines (head, lines, max = 2000) {
  const shown = []
  for (const [i, line] of lines.entries()) {
    const rest = lines.length - i - 1
    const tail = rest ? `\n…ほか ${rest} 本` : ''
    if ([head, ...shown, line].join('\n').length + tail.length > max) {
      return `${[head, ...shown].join('\n')}\n…ほか ${lines.length - i} 本`
    }
    shown.push(line)
  }
  return [head, ...shown].join('\n')
}

async function run (interaction) {
  const [sub] = interaction.data.options
  if (!process.env.YOUTUBE_API_KEY) {
    return { content: 'YOUTUBE_API_KEY が設定されていないため使えません。' }
  }
  // A video given by its link needs no channel.
  if (sub.name === 'summarize' && sub.options?.some(o => o.name === 'url')) return summarize(interaction, sub)
  const stored = await youtubeDB.getKnowledge(interaction.guildID)
  if (!stored) return { content: 'BOT が見ている YouTube チャンネルがありません（環境変数 `YOUTUBE_CHANNELS` で設定します）。' }
  if (sub.name === 'sync') {
    // The channels are the bot's: reading them again is for the owner's servers.
    if (!isOwnerGuild(interaction.guildID)) return { content: 'チャンネルは BOT 共通のため、取得し直しはオーナーのサーバーからのみできます（新しい動画は自動で取得されます）。' }
    const { knowledge, note } = await sync(interaction.guildID)
    return { content: `最新の情報を取得しました。${note}`, embeds: [summary(knowledge)] }
  }
  if (sub.name === 'summarize') return summarize(interaction, sub)
  if (sub.name === 'liveevents') return liveEvents(interaction, sub)
  return { embeds: [summary(stored)] }
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
      reply = { content: `YouTube の情報を取得できませんでした: ${e.hint || redact(e.message).slice(0, 300)}`, embeds: [], components: [] }
    }
    // summarize answers by itself.
    if (reply) await interaction.editOriginalMessage(reply).catch(() => {})
  }
}
