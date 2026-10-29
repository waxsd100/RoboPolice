const { EMBED_COLORS } = require('../utils/constants')
const { parseChannelRef, resolveChannel, fetchChannelKnowledge } = require('../utils/youtube')
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

// Reads the configured channel from YouTube and adds to what is stored: the whole channel the first
// time, afterwards only what is new (plus the newest page again, for streams that changed state).
async function sync (guildID) {
  const stored = await youtubeDB.getOverview(guildID)
  const knownIds = await youtubeDB.getVideoIds(guildID)
  // Rows set before channel IDs were stored have only the reference.
  const ref = stored.channel_id ? { id: stored.channel_id } : parseChannelRef(stored.channel_ref)
  const knowledge = await fetchChannelKnowledge(ref, process.env.YOUTUBE_API_KEY, { knownIds, backfillToken: stored.backfill_token })
  await youtubeDB.saveSync(guildID, knowledge)
  const added = new Set(knowledge.videos.filter(v => !knownIds.has(v.id)).map(v => v.id)).size
  const note = [`新しく ${added} 件の動画を保存しました。`]
  if (knowledge.backfillToken) note.push('動画が多いため、残りの古い動画は次の `/youtube sync` で続きから取得します。')
  return { knowledge: await youtubeDB.getKnowledge(guildID), note: note.join('') }
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
    await interaction.editOriginalMessage(reply).catch(() => {})
  }
}
