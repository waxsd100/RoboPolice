const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { draft, isConfigured, ENTITY_TYPES } = require('./eventDrafter')
const { createTools, StopDrafting } = require('./eventTools')
const { EMBED_COLORS } = require('../utils/constants')
const { hasStaffAccess } = require('../utils/staffAccess')
const { redact } = require('../utils/redact')

const ANSWER_TIMEOUT_MS = 5 * 60 * 1000
// How much of the error log to show in the reply; Discord messages are capped at 2000 characters.
const MAX_ERROR_LOG = 1500
const { BUTTON } = Eris.Constants.ComponentTypes
const { PRIMARY, SECONDARY, SUCCESS, DANGER } = Eris.Constants.ButtonStyles

// One draft at a time per user, so repeated mentions don't stack up Gemini calls.
const inProgress = new Set()

// Only an explicit @mention in the text. message.mentions also includes the author of a replied-to
// message, so replying to one of the bot's own answers would otherwise start a new draft.
function isMentioned (message) {
  return new RegExp(`<@!?${global.bot.user.id}>`).test(message.content)
}

// The assistant is a tool for the people who run the server, so it is limited to members who can
// manage events. Posting to a forum additionally needs permission to post in that forum.
function canUseAssistant (member, guild) {
  return member.id === guild.ownerID ||
    member.permissions.has('manageEvents') ||
    member.permissions.has('administrator') ||
    hasStaffAccess(member.roles, guild)
}

function extractRequest (message) {
  return message.content.replace(new RegExp(`<@!?${global.bot.user.id}>`, 'g'), '').trim()
}

// The error log for the reply: message and the top of the stack, with secrets masked, since the
// reply may be in a channel many people can read.
function errorLog (e) {
  const text = redact(e.stack || `${e.name}: ${e.message}`)
  const log = text.length > MAX_ERROR_LOG ? `${text.slice(0, MAX_ERROR_LOG)}\n…（以下省略）` : text
  return `\`\`\`\n${log.replace(/```/g, '`\u200b``')}\n\`\`\``
}

function sourcesField (sources) {
  return sources.length === 0 ? [] : [{ name: '参照元', value: sources.join('\n').slice(0, 1024) }]
}

function eventPreview ({ event, endGuessed }, sources, requester) {
  const start = Math.floor(Date.parse(event.scheduled_start_time) / 1000)
  const end = Math.floor(Date.parse(event.scheduled_end_time) / 1000)
  const where = event.entity_type === ENTITY_TYPES.external
    ? event.entity_metadata.location
    : `<#${event.channel_id}>`
  return {
    title: event.name,
    description: event.description || '（説明なし）',
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: '開始', value: `<t:${start}:F>（<t:${start}:R>）`, inline: true },
      { name: '終了', value: `<t:${end}:F>${endGuessed ? '\n（不明のため開始から1時間後）' : ''}`, inline: true },
      { name: '場所', value: where },
      ...sourcesField(sources)
    ],
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「登録する」を押してください` }
  }
}

function forumPreview ({ post, tagNames, truncated }, sources, requester) {
  return {
    title: post.name,
    description: post.message.content,
    color: EMBED_COLORS.GREEN,
    fields: [
      { name: '投稿先', value: `<#${post.channelID}>`, inline: true },
      { name: 'タグ', value: tagNames.join(', ') || 'なし', inline: true },
      ...(truncated ? [{ name: '注意', value: '本文が2000文字を超えたため、超えた分は切り捨てます。' }] : []),
      ...sourcesField(sources)
    ],
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「投稿する」を押してください` }
  }
}

// What each kind of draft looks like and how it is created once the requester confirms.
const KINDS = {
  event: {
    preview: eventPreview,
    confirmLabel: '登録する',
    async create (result, guild, author) {
      if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
        return 'BOTに「イベントの管理」権限がないため、イベントを登録できませんでした。'
      }
      const created = await global.bot.requestHandler.request('POST', `/guilds/${guild.id}/scheduled-events`, true, {
        ...result.event,
        reason: `Requested by ${author.username} (${author.id})`
      })
      return `イベントを登録しました: https://discord.com/events/${guild.id}/${created.id}`
    }
  },
  forum: {
    preview: forumPreview,
    confirmLabel: '投稿する',
    async create (result, guild, author) {
      const { channelID, ...body } = result.post
      const thread = await global.bot.requestHandler.request('POST', `/channels/${channelID}/threads`, true, {
        ...body,
        reason: `Requested by ${author.username} (${author.id})`
      })
      return `フォーラムに投稿しました: https://discord.com/channels/${guild.id}/${thread.id}`
    }
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
  if (!canUseAssistant(message.member, guild)) {
    return message.channel.createMessage({ content: 'この機能を使うには「イベントの管理」権限が必要です。', ...reference }).catch(() => {})
  }

  const request = extractRequest(message)
  const repliedTo = message.messageReference?.messageID
  if (!request && !repliedTo) {
    return message.channel.createMessage({ content: 'イベントやフォーラム投稿にしたい内容（文章・URL・メッセージリンク）を添えるか、元のメッセージに返信する形でメンションしてください。', ...reference }).catch(() => {})
  }
  if (inProgress.has(message.author.id)) {
    return message.channel.createMessage({ content: '前の依頼を処理中です。終わってからもう一度お試しください。', ...reference }).catch(() => {})
  }

  inProgress.add(message.author.id)
  let reply
  try {
    reply = await message.channel.createMessage({ content: '内容を読み取っています…', ...reference })
    const member = message.member
    const tools = createTools({ guild, member, ask: asker(reply, message.author.id) })
    // A mention sent as a reply ("@bot これをイベントにして") is about the replied-to message.
    const referenced = repliedTo
      ? await tools.readMessage(message.messageReference.channelID || message.channel.id, repliedTo).catch(e => `（読めませんでした: ${e.message}）`)
      : null
    const result = await draft({ request, referenced, channelName: message.channel.name, guild, member, tools })
    if (result.error) {
      await reply.edit({ content: `作成できませんでした: ${result.error}` })
      return
    }

    const kind = KINDS[result.kind]
    const embed = kind.preview(result, [...new Set(tools.sources)], message.author)
    const picked = await choose(reply, message.author.id, { content: '', embeds: [embed] }, [
      { label: kind.confirmLabel, style: SUCCESS },
      { label: 'キャンセル', style: DANGER }
    ])
    if (!picked) {
      await reply.edit({ content: '時間内に確認されなかったため、取りやめました。', components: [] })
      return
    }
    const { interaction } = picked
    if (picked.index !== 0) {
      await interaction.editOriginalMessage({ content: 'キャンセルしました。', components: [] })
      return
    }
    await interaction.editOriginalMessage({ content: await kind.create(result, guild, message.author), components: [] })
  } catch (e) {
    if (e instanceof StopDrafting) {
      await reply.edit({ content: e.message, embeds: [], components: [] }).catch(() => {})
      return
    }
    global.logger.error(e)
    // The console log alone is easy to miss; also send it to the error webhook the operators watch.
    global.webhook.error(redact(`Drafting from a mention in ${guild.id} failed: ${e.message}`).slice(0, 2000))
    const cause = e.hint || (e.name === 'TimeoutError' ? 'AI の応答が時間内に返りませんでした' : null)
    const content = `作成中にエラーが発生しました${cause ? `（${cause}）` : ''}。時間をおいてもう一度お試しください。\n${errorLog(e)}`
    if (reply) {
      await reply.edit({ content, embeds: [], components: [] }).catch(() => {})
    } else {
      await message.channel.createMessage({ content, ...reference }).catch(() => {})
    }
  } finally {
    inProgress.delete(message.author.id)
  }
}

module.exports = { handle, extractRequest }
