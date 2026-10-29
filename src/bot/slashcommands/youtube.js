const { EMBED_COLORS } = require('../utils/constants')
const { parseChannelRef, fetchChannelKnowledge, MAX_VIDEOS } = require('../utils/youtube')
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
      { name: '保存している動画', value: `${videos.length} 件`, inline: true },
      ...(lives.length ? [{ name: '配信', value: lives.slice(0, 5).map(v => `${LIVE_LABELS[v.live_status]}: [${v.title}](${v.url})`).join('\n') }] : [])
    ]
  }
}

// Reads the configured channel from YouTube and replaces what is stored for the server.
async function sync (guildID) {
  const stored = await youtubeDB.getKnowledge(guildID)
  const knowledge = await fetchChannelKnowledge(parseChannelRef(stored.channel.channel_ref), process.env.YOUTUBE_API_KEY)
  await youtubeDB.saveSync(guildID, knowledge)
  return youtubeDB.getKnowledge(guildID)
}

async function run (interaction) {
  const [sub] = interaction.data.options
  if (!process.env.YOUTUBE_API_KEY) {
    return { content: 'YOUTUBE_API_KEY が設定されていないため使えません。' }
  }
  if (sub.name === 'set') {
    const input = sub.options.find(o => o.name === 'channel').value
    if (!parseChannelRef(input)) {
      return { content: 'YouTube チャンネルの URL（https://www.youtube.com/@名前 または /channel/UC…）か、@名前 を指定してください。' }
    }
    await youtubeDB.setChannelRef(interaction.guildID, input.trim())
    return { content: 'YouTube チャンネルを設定し、情報を取得しました。メンションで依頼したときに AI が参照します。', embeds: [summary(await sync(interaction.guildID))] }
  }
  const stored = await youtubeDB.getKnowledge(interaction.guildID)
  if (!stored) return { content: 'YouTube チャンネルが設定されていません。`/youtube set` で設定してください。' }
  if (sub.name === 'sync') {
    return { content: `最新の情報を取得しました（最大${MAX_VIDEOS}件の動画）。`, embeds: [summary(await sync(interaction.guildID))] }
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
