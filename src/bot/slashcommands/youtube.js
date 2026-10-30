const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { EMBED_COLORS } = require('../utils/constants')
const { parseChannelRef, parseVideoId, resolveChannel } = require('../utils/youtube')
const { sync, videosToSummarize, summarizeLatest } = require('../modules/youtubeSync')
const { summarizeVideo } = require('../modules/videoSummary')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { redact } = require('../utils/redact')

const LIVE_LABELS = { live: '配信中', upcoming: '配信予定' }

function summary ({ channel, videos }) {
  const synced = channel.synced_at ? `<t:${Math.floor(new Date(channel.synced_at) / 1000)}:R>` : '未取得'
  const lives = videos.filter(v => LIVE_LABELS[v.live_status])
  return {
    title: channel.title || channel.channel_ref,
    url: channel.url || undefined,
    description: (channel.description || '').slice(0, 300) || undefined,
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: '設定', value: channel.channel_ref, inline: true },
      { name: '最終取得', value: synced, inline: true },
      { name: '保存している動画', value: `${videos.length} 件（内容の要約あり ${videos.filter(v => v.summary).length} 件）`, inline: true },
      { name: '配信のイベント登録', value: channel.live_events ? '有効' : '無効（`/youtube liveevents enabled:True`）', inline: true },
      ...(lives.length ? [{ name: '配信', value: lives.slice(0, 5).map(v => `${LIVE_LABELS[v.live_status]}: [${v.title}](${v.url})`).join('\n') }] : [])
    ]
  }
}

const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000
const { BUTTON, ACTION_ROW } = Eris.Constants.ComponentTypes
const { SUCCESS, DANGER } = Eris.Constants.ButtonStyles

// Shows the channel that was found and waits for the member who ran the command to press はい or
// いいえ. Setting a different channel drops what is stored for the current one, so that is said.
// Resolves to true only for はい.
async function confirmChannel (interaction, channel) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const current = await youtubeDB.getOverview(interaction.guildID)
  const replacing = current?.channel_id && current.channel_id !== channel.id
  const [yes, no] = [uuidv4(), uuidv4()]
  await interaction.editOriginalMessage({
    content: [
      'このチャンネルを設定しますか？',
      replacing ? `⚠️ 今の「${current.title || current.channel_ref}」から変わり、保存している動画 ${current.video_count} 件と情報は削除されます。` : ''
    ].filter(Boolean).join('\n'),
    embeds: [{
      title: channel.snippet.title,
      url: `https://www.youtube.com/channel/${channel.id}`,
      description: (channel.snippet.description || '').slice(0, 200) || undefined,
      thumbnail: channel.snippet.thumbnails?.default?.url ? { url: channel.snippet.thumbnails.default.url } : undefined,
      color: EMBED_COLORS.PURPLED_BLUE
    }],
    components: [{
      type: ACTION_ROW,
      components: [
        { type: BUTTON, style: SUCCESS, label: 'はい', custom_id: yes },
        { type: BUTTON, style: DANGER, label: 'いいえ', custom_id: no }
      ]
    }]
  })
  const userID = interaction.member?.user?.id || interaction.user?.id
  try {
    const pressed = await Promise.race([yes, no].map(id => awaitCustomID(id, userID, CONFIRM_TIMEOUT_MS)))
    return pressed.data.custom_id === yes
  } catch (_) {
    return false
  } finally {
    [yes, no].forEach(cancelCustomID)
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
      ? 'これから始まる配信と、配信予定の枠を、サーバーのイベントとして自動で登録します。配信が始まるとイベントも開始し、終わると終了します（通常の動画は対象外です）。'
      : '配信のイベント登録をやめました。登録済みのイベントはそのまま残ります。'
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
    const text = summary.length > MAX_SHOWN_SUMMARY ? `${summary.slice(0, MAX_SHOWN_SUMMARY)}…` : summary
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
      onProgress: (done, total, video) => interaction.editOriginalMessage({ content: `動画の内容を要約しています（${done + 1}/${total}）: ${video.title}\n長い動画は1本で数分かかります。` }).catch(() => {})
    })
    const lines = results.map(({ video, error }) => error ? `⚠️ ${video.title}: ${error}` : `✅ [${video.title}](${video.url})`)
    const content = `${results.filter(r => !r.error).length}/${results.length} 本の動画を${force ? '要約し直しました' : '要約しました'}。メンションで依頼したときに AI が参照します。\n${lines.join('\n')}`.slice(0, 2000)
    await finish(interaction, content)
    return null
  } finally {
    summarizing.delete(guildID)
  }
}

async function run (interaction) {
  const [sub] = interaction.data.options
  if (!process.env.YOUTUBE_API_KEY) {
    return { content: 'YOUTUBE_API_KEY が設定されていないため使えません。' }
  }
  if (sub.name === 'set') {
    const input = sub.options.find(o => o.name === 'channel').value
    const ref = parseChannelRef(input)
    if (!ref) {
      return { content: 'YouTube チャンネルの URL（https://www.youtube.com/@名前 または /channel/UC…）か、@名前 を指定してください。' }
    }
    // Resolved before anything is stored: a channel that does not exist changes nothing.
    const channel = await resolveChannel(ref, process.env.YOUTUBE_API_KEY)
    if (!await confirmChannel(interaction, channel)) {
      return { content: 'YouTube チャンネルの設定をやめました。', embeds: [], components: [] }
    }
    await interaction.editOriginalMessage({ content: 'チャンネルの情報を取得しています…', embeds: [], components: [] }).catch(() => {})
    await youtubeDB.setChannel(interaction.guildID, input.trim(), channel.id)
    const { knowledge, note } = await sync(interaction.guildID)
    return { content: `YouTube チャンネルを設定し、情報を取得しました。${note}メンションで依頼したときに AI が参照します。`, embeds: [summary(knowledge)], components: [] }
  }
  // A video given by its link needs no channel to be set.
  if (sub.name === 'summarize' && sub.options?.some(o => o.name === 'url')) return summarize(interaction, sub)
  const stored = await youtubeDB.getKnowledge(interaction.guildID)
  if (!stored) return { content: 'YouTube チャンネルが設定されていません。`/youtube set` で設定してください。' }
  if (sub.name === 'sync') {
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
