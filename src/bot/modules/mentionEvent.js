const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { draftEvent, isConfigured, ENTITY_TYPES } = require('./eventDrafter')
const { createTools, StopDrafting } = require('./eventTools')
const { EMBED_COLORS } = require('../utils/constants')
const { hasStaffAccess } = require('../utils/staffAccess')

const ANSWER_TIMEOUT_MS = 5 * 60 * 1000
const { BUTTON } = Eris.Constants.ComponentTypes
const { PRIMARY, SECONDARY, SUCCESS, DANGER } = Eris.Constants.ButtonStyles

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

// Shows `buttons` on the reply and waits for the requester to press one. Resolves to the pressed
// button's index and its interaction, or null if nobody pressed within the timeout.
async function choose (reply, requesterID, message, buttons) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const ids = buttons.map(() => uuidv4())
  await reply.edit({
    ...message,
    components: [{
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: buttons.map((b, i) => ({ type: BUTTON, style: b.style, label: b.label.slice(0, 80), custom_id: ids[i] }))
    }]
  })
  try {
    const interaction = await Promise.race(ids.map(id => awaitCustomID(id, requesterID, ANSWER_TIMEOUT_MS)))
    return { index: ids.indexOf(interaction.data.custom_id), interaction }
  } catch (_) {
    return null
  } finally {
    ids.forEach(cancelCustomID)
  }
}

// The ask_user tool: the model's question as buttons, plus a way out.
function asker (reply, requesterID) {
  return async (question, options) => {
    const picked = await choose(reply, requesterID, {
      content: '',
      embeds: [{ title: '確認させてください', description: question, color: EMBED_COLORS.YELLOW_ORANGE }]
    }, [...options.map(label => ({ label, style: PRIMARY })), { label: 'やめる', style: SECONDARY }])
    if (!picked) throw new StopDrafting('時間内に回答がなかったため、作成を取りやめました。')
    if (picked.index === options.length) throw new StopDrafting('作成をやめました。')
    await reply.edit({ content: `「${options[picked.index]}」で続けます…`, embeds: [], components: [] })
    return options[picked.index]
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
    const tools = createTools({ guild, member: message.member, ask: asker(reply, message.author.id) })
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
    const picked = await choose(reply, message.author.id, { content: '', embeds: [embed] }, [
      { label: '登録する', style: SUCCESS },
      { label: 'キャンセル', style: DANGER }
    ])
    if (!picked) {
      await reply.edit({ content: '時間内に確認されなかったため、登録を取りやめました。', components: [] })
      return
    }
    const { interaction } = picked
    if (picked.index !== 0) {
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
    if (e instanceof StopDrafting) {
      await reply.edit({ content: e.message, embeds: [], components: [] }).catch(() => {})
      return
    }
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
