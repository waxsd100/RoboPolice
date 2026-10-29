const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { draftEvent, isConfigured, ENTITY_TYPES } = require('./eventDrafter')
const { createTools } = require('./eventTools')
const { EMBED_COLORS } = require('../utils/constants')
const { hasStaffAccess } = require('../utils/staffAccess')

const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000

// One draft at a time per user, so repeated mentions don't stack up Gemini calls.
const inProgress = new Set()

// Only an explicit @mention in the text. message.mentions also includes the author of a replied-to
// message, so replying to one of the bot's own answers would otherwise start a new draft.
function isMentioned (message) {
  return new RegExp(`<@!?${global.bot.user.id}>`).test(message.content)
}

function canManageEvents (member, guild) {
  return member.id === guild.ownerID ||
    member.permissions.has('manageEvents') ||
    member.permissions.has('administrator') ||
    hasStaffAccess(member.roles, guild)
}

function extractRequest (message) {
  return message.content.replace(new RegExp(`<@!?${global.bot.user.id}>`, 'g'), '').trim()
}

function previewEmbed (event, sources, endGuessed, requester) {
  const start = Math.floor(Date.parse(event.scheduled_start_time) / 1000)
  const end = Math.floor(Date.parse(event.scheduled_end_time) / 1000)
  const where = event.entity_type === ENTITY_TYPES.external
    ? event.entity_metadata.location
    : `<#${event.channel_id}>`
  const fields = [
    { name: '開始', value: `<t:${start}:F>（<t:${start}:R>）`, inline: true },
    { name: '終了', value: `<t:${end}:F>${endGuessed ? '\n（不明のため開始から1時間後）' : ''}`, inline: true },
    { name: '場所', value: where }
  ]
  if (sources.length !== 0) fields.push({ name: '参照元', value: sources.join('\n').slice(0, 1024) })
  return {
    title: event.name,
    description: event.description || '（説明なし）',
    color: EMBED_COLORS.PURPLED_BLUE,
    fields,
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「登録する」を押してください` }
  }
}

async function confirm (reply, requesterID, embed) {
  const { awaitCustomID } = require('../events/interactionCreate')
  const createID = uuidv4()
  const cancelID = uuidv4()
  await reply.edit({
    content: '',
    embeds: [embed],
    components: [{
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: [
        { type: Eris.Constants.ComponentTypes.BUTTON, style: Eris.Constants.ButtonStyles.SUCCESS, label: '登録する', custom_id: createID },
        { type: Eris.Constants.ComponentTypes.BUTTON, style: Eris.Constants.ButtonStyles.DANGER, label: 'キャンセル', custom_id: cancelID }
      ]
    }]
  })
  try {
    const interaction = await Promise.race([
      awaitCustomID(createID, requesterID, CONFIRM_TIMEOUT_MS),
      awaitCustomID(cancelID, requesterID, CONFIRM_TIMEOUT_MS)
    ])
    return { interaction, confirmed: interaction.data.custom_id === createID }
  } catch (_) {
    return { interaction: null, confirmed: false }
  }
}

async function handle (message) {
  if (!isMentioned(message)) return
  const guild = message.channel.guild
  const reference = { messageReference: { messageID: message.id, failIfNotExists: false } }

  if (!isConfigured()) return
  if (!canManageEvents(message.member, guild)) {
    return message.channel.createMessage({ content: 'イベントを登録するには「イベントの管理」権限が必要です。', ...reference }).catch(() => {})
  }
  if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    return message.channel.createMessage({ content: 'BOTに「イベントの管理」権限がないため、イベントを登録できません。', ...reference }).catch(() => {})
  }

  const request = extractRequest(message)
  const repliedTo = message.messageReference?.messageID
  if (!request && !repliedTo) {
    return message.channel.createMessage({ content: 'イベントにしたい内容（文章・URL・メッセージリンク）を添えるか、元のメッセージに返信する形でメンションしてください。', ...reference }).catch(() => {})
  }
  if (inProgress.has(message.author.id)) {
    return message.channel.createMessage({ content: '前の依頼を処理中です。終わってからもう一度お試しください。', ...reference }).catch(() => {})
  }

  inProgress.add(message.author.id)
  let reply
  try {
    reply = await message.channel.createMessage({ content: '内容を読み取っています…', ...reference })
    const tools = createTools({ guild, member: message.member })
    // A mention sent as a reply ("@bot これをイベントにして") is about the replied-to message.
    const referenced = repliedTo
      ? await tools.readMessage(message.messageReference.channelID || message.channel.id, repliedTo).catch(e => `（読めませんでした: ${e.message}）`)
      : null
    const result = await draftEvent({ request, referenced, channelName: message.channel.name, guild, tools })
    if (result.error) {
      await reply.edit({ content: `イベントを作成できませんでした: ${result.error}` })
      return
    }

    const embed = previewEmbed(result.event, [...new Set(tools.sources)], result.endGuessed, message.author)
    const { interaction, confirmed } = await confirm(reply, message.author.id, embed)
    if (!interaction) {
      await reply.edit({ content: '時間内に確認されなかったため、登録を取りやめました。', components: [] })
      return
    }
    if (!confirmed) {
      await interaction.editOriginalMessage({ content: '登録をキャンセルしました。', components: [] })
      return
    }

    const created = await global.bot.requestHandler.request('POST', `/guilds/${guild.id}/scheduled-events`, true, {
      ...result.event,
      reason: `Requested by ${message.author.username} (${message.author.id})`
    })
    await interaction.editOriginalMessage({
      content: `イベントを登録しました: https://discord.com/events/${guild.id}/${created.id}`,
      components: []
    })
  } catch (e) {
    global.logger.error(e)
    const content = 'イベントの作成中にエラーが発生しました。時間をおいてもう一度お試しください。'
    if (reply) {
      await reply.edit({ content, components: [] }).catch(() => {})
    } else {
      await message.channel.createMessage({ content, ...reference }).catch(() => {})
    }
  } finally {
    inProgress.delete(message.author.id)
  }
}

module.exports = { handle, extractRequest }
