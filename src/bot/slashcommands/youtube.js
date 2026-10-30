const { EMBED_COLORS } = require('../utils/constants')
const { parseChannelRef, resolveChannel } = require('../utils/youtube')
const { sync, videosToSummarize, summarizeLatest } = require('../modules/youtubeSync')
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
      ...(lives.length ? [{ name: '配信', value: lives.slice(0, 5).map(v => `${LIVE_LABELS[v.live_status]}: [${v.title}](${v.url})`).join('\n') }] : [])
    ]
  }
}

const DEFAULT_SUMMARIES = 3
// One bulk summary at a time per server: each is several long Gemini calls.
const summarizing = new Set()

// Summarizes the newest videos that have none. Each can take minutes, longer than an interaction
// can be edited (15 minutes), so the result also goes to the channel if the edit fails.
async function summarize (interaction, sub) {
  const count = sub.options?.find(o => o.name === 'count')?.value || DEFAULT_SUMMARIES
  const guildID = interaction.guildID
  if (summarizing.has(guildID)) return { content: '別の要約を実行中です。終わってからもう一度お試しください。' }
  const videos = await videosToSummarize(guildID, count)
  if (videos.length === 0) return { content: '要約していない動画はありません（配信中・配信予定のものは除きます）。' }
  summarizing.add(guildID)
  try {
    const results = await summarizeLatest(guildID, videos, {
      onProgress: (done, total, video) => interaction.editOriginalMessage({ content: `動画の内容を要約しています（${done + 1}/${total}）: ${video.title}\n長い動画は1本で数分かかります。` }).catch(() => {})
    })
    const lines = results.map(({ video, error }) => error ? `⚠️ ${video.title}: ${error}` : `✅ [${video.title}](${video.url})`)
    const content = `${results.filter(r => !r.error).length}/${results.length} 本の動画を要約しました。メンションで依頼したときに AI が参照します。\n${lines.join('\n')}`.slice(0, 2000)
    const edited = await interaction.editOriginalMessage({ content }).then(() => true, () => false)
    if (!edited && interaction.channel?.id) await global.bot.createMessage(interaction.channel.id, { content }).catch(() => {})
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
    await youtubeDB.setChannel(interaction.guildID, input.trim(), channel.id)
    const { knowledge, note } = await sync(interaction.guildID)
    return { content: `YouTube チャンネルを設定し、情報を取得しました。${note}メンションで依頼したときに AI が参照します。`, embeds: [summary(knowledge)] }
  }
  const stored = await youtubeDB.getKnowledge(interaction.guildID)
  if (!stored) return { content: 'YouTube チャンネルが設定されていません。`/youtube set` で設定してください。' }
  if (sub.name === 'sync') {
    const { knowledge, note } = await sync(interaction.guildID)
    return { content: `最新の情報を取得しました。${note}`, embeds: [summary(knowledge)] }
  }
  if (sub.name === 'summarize') return summarize(interaction, sub)
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
      reply = { content: `YouTube の情報を取得できませんでした: ${e.hint || redact(e.message).slice(0, 300)}` }
    }
    // summarize answers by itself.
    if (reply) await interaction.editOriginalMessage(reply).catch(() => {})
  }
}
