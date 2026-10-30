const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { draft, revise, isConfigured, ENTITY_TYPES } = require('./eventDrafter')
const { createTools, describeServer, StopDrafting } = require('./eventTools')
const { EMBED_COLORS } = require('../utils/constants')
const { hasStaffAccess } = require('../utils/staffAccess')
const { redact } = require('../utils/redact')
const { SIZES } = require('../utils/imageCrop')
const { CoverImage, MODES } = require('./coverImage')
const { FORUM_TYPES } = require('./forumPost')

const ANSWER_TIMEOUT_MS = 5 * 60 * 1000
// How much of the error log to show in the reply; Discord messages are capped at 2000 characters.
const MAX_ERROR_LOG = 1500
const { BUTTON } = Eris.Constants.ComponentTypes
const { PRIMARY, SECONDARY, SUCCESS, DANGER } = Eris.Constants.ButtonStyles

// Corrections to one draft; after that the requester can cancel and mention again.
const MAX_REVISIONS = 3
const BUTTONS_PER_ROW = 5

// One draft at a time per user, so repeated mentions don't stack up Gemini calls.
const inProgress = new Set()

// Typed answers we are waiting for, by "channelID:userID": the requester's next message in the
// channel is the answer (a correction, or a free-text reply to a question).
const waitingReplies = new Map()

function awaitReply (channelID, userID) {
  const key = `${channelID}:${userID}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waitingReplies.delete(key)
      resolve(null)
    }, ANSWER_TIMEOUT_MS)
    waitingReplies.set(key, text => {
      clearTimeout(timer)
      waitingReplies.delete(key)
      resolve(text)
    })
  })
}

// Hands `message` to a waiting awaitReply(), if it is the answer one is waiting for.
function takeReply (message) {
  const waiting = waitingReplies.get(`${message.channel.id}:${message.author.id}`)
  if (!waiting || !message.content.trim() || isMentioned(message)) return false
  waiting(message.content.trim())
  return true
}

// The bot's own role, which Discord creates when the bot joins. Typing "@ロボポリス" offers it next
// to the bot itself, and picking it sends a role mention that otherwise looked like no mention.
function isOwnRole (guild, roleID) {
  return guild.roles.get(roleID)?.tags?.bot_id === global.bot.user.id
}

// Mentions in the text that address the bot: the bot itself or its own role.
function mentionPattern () {
  return new RegExp(`<@!?${global.bot.user.id}>|<@&(\\d+)>`, 'g')
}

// Only an explicit @mention in the text. message.mentions also includes the author of a replied-to
// message, so replying to one of the bot's own answers would otherwise start a new draft.
function isMentioned (message) {
  const guild = message.channel.guild
  return [...message.content.matchAll(mentionPattern())].some(m => !m[1] || isOwnRole(guild, m[1]))
}

let warnedUnconfigured = false
function missingSettings () {
  return ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID'].filter(name => !process.env[name])
}

// The assistant is a tool for the people who run the server, so it is limited to members who can
// manage events. Posting to a forum additionally needs permission to post in that forum.
function canUseAssistant (member, guild) {
  return member.id === guild.ownerID ||
    member.permissions.has('manageEvents') ||
    member.permissions.has('administrator') ||
    hasStaffAccess(member.roles, guild)
}

// A forum channel mentioned in the request (<#id>) is where a forum post must go.
function namedForum (message) {
  for (const [, id] of message.content.matchAll(/<#(\d+)>/g)) {
    const channel = message.channel.guild.channels.get(id)
    if (channel && FORUM_TYPES.includes(channel.type)) return { id: channel.id, name: channel.name }
  }
  return null
}

function attachedImages (message) {
  return (message.attachments || [])
    .filter(a => /^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp|gif|avif)$/i.test(a.filename || ''))
    .map(a => a.url)
}

function extractRequest (message) {
  const guild = message.channel.guild
  return message.content
    .replace(mentionPattern(), (whole, roleID) => !roleID || isOwnRole(guild, roleID) ? '' : whole)
    .trim()
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

// The preview shows the rendered cover as an attachment, so the requester sees the real result.
const PREVIEW_IMAGE = 'cover.jpg'

function coverParts (cover) {
  return {
    fields: [{ name: '画像', value: cover.describe() }],
    image: cover.buffer ? { url: `attachment://${PREVIEW_IMAGE}` } : undefined
  }
}

function eventPreview ({ event, endGuessed }, sources, requester, cover) {
  const start = Math.floor(Date.parse(event.scheduled_start_time) / 1000)
  const end = Math.floor(Date.parse(event.scheduled_end_time) / 1000)
  const where = event.entity_type === ENTITY_TYPES.external
    ? event.entity_metadata.location
    : `<#${event.channel_id}>`
  const image = coverParts(cover)
  return {
    title: event.name,
    description: event.description || '（説明なし）',
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: '開始', value: `<t:${start}:F>（<t:${start}:R>）`, inline: true },
      { name: '終了', value: `<t:${end}:F>${endGuessed ? '\n（不明のため開始から1時間後）' : ''}`, inline: true },
      { name: '場所', value: where },
      ...image.fields,
      ...sourcesField(sources)
    ],
    image: image.image,
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「登録する」を押してください` }
  }
}

function forumPreview ({ post, tagNames, truncated }, sources, requester, cover) {
  const image = coverParts(cover)
  return {
    title: post.name,
    description: post.message.content,
    color: EMBED_COLORS.GREEN,
    fields: [
      { name: '投稿先', value: `<#${post.channelID}>`, inline: true },
      { name: 'タグ', value: tagNames.join(', ') || 'なし', inline: true },
      ...(truncated ? [{ name: '注意', value: '本文が2000文字を超えたため、超えた分は切り捨てます。' }] : []),
      ...image.fields,
      ...sourcesField(sources)
    ],
    image: image.image,
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「投稿する」を押してください` }
  }
}

// What each kind of draft looks like and how it is created once the requester confirms.
const KINDS = {
  event: {
    preview: eventPreview,
    confirmLabel: '登録する',
    size: SIZES.eventCover,
    text: ({ event }) => ({ title: event.name, summary: event.description }),
    async create (result, guild, author, cover) {
      if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
        return 'BOTに「イベントの管理」権限がないため、イベントを登録できませんでした。'
      }
      const created = await global.bot.requestHandler.request('POST', `/guilds/${guild.id}/scheduled-events`, true, {
        ...result.event,
        ...(cover.buffer ? { image: `data:image/jpeg;base64,${cover.buffer.toString('base64')}` } : {}),
        reason: `Requested by ${author.username} (${author.id})`
      })
      return `イベントを登録しました: https://discord.com/events/${guild.id}/${created.id}`
    }
  },
  forum: {
    preview: forumPreview,
    confirmLabel: '投稿する',
    size: SIZES.forumImage,
    text: ({ post }) => ({ title: post.name, summary: post.message.content }),
    async create (result, guild, author, cover) {
      const { channelID, ...body } = result.post
      // The image is uploaded as files[0] and named through message.attachments, as Discord's
      // multipart convention asks; Eris sends the body as payload_json alongside it.
      const files = cover.buffer ? [{ name: 'files[0]', file: cover.buffer }] : undefined
      if (files) body.message = { ...body.message, attachments: [{ id: 0, filename: 'image.jpg' }] }
      const thread = await global.bot.requestHandler.request('POST', `/channels/${channelID}/threads`, true, {
        ...body,
        reason: `Requested by ${author.username} (${author.id})`
      }, files)
      return `フォーラムに投稿しました: https://discord.com/channels/${guild.id}/${thread.id}`
    }
  }
}

// Edits the reply. With `image` (a Buffer, or null to remove it) the edit goes through the REST
// API directly: the pinned Eris cannot attach files when editing a message.
async function editReply (reply, payload, image) {
  if (image === undefined) return reply.edit(payload)
  return global.bot.requestHandler.request('PATCH', `/channels/${reply.channel.id}/messages/${reply.id}`, true, {
    ...payload,
    attachments: image ? [{ id: 0, filename: PREVIEW_IMAGE }] : []
  }, image ? [{ name: 'files[0]', file: image }] : undefined)
}

// Lays buttons out in rows: buttons with the same `row` (default 0) share rows of up to five.
function buttonRows (buttons, ids) {
  const groups = new Map()
  buttons.forEach((b, i) => {
    const row = b.row ?? 0
    if (!groups.has(row)) groups.set(row, [])
    groups.get(row).push({ type: BUTTON, style: b.style, label: b.label.slice(0, 80), custom_id: ids[i] })
  })
  const rows = []
  for (const components of groups.values()) {
    for (let i = 0; i < components.length; i += BUTTONS_PER_ROW) {
      rows.push({ type: Eris.Constants.ComponentTypes.ACTION_ROW, components: components.slice(i, i + BUTTONS_PER_ROW) })
    }
  }
  return rows
}

// Shows `buttons` on the reply and waits for the requester to press one. Resolves to the pressed
// button's index and its interaction, or null if nobody pressed within the timeout.
async function choose (reply, requesterID, message, buttons, image) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const ids = buttons.map(() => uuidv4())
  await editReply(reply, { ...message, components: buttonRows(buttons, ids) }, image)
  try {
    const interaction = await Promise.race(ids.map(id => awaitCustomID(id, requesterID, ANSWER_TIMEOUT_MS)))
    return { index: ids.indexOf(interaction.data.custom_id), interaction }
  } catch (_) {
    return null
  } finally {
    ids.forEach(cancelCustomID)
  }
}

// Asks the requester to type their answer as their next message in the channel.
async function typedAnswer (reply, channelID, requesterID, prompt) {
  await reply.edit({ content: `${prompt}（5分以内にこのチャンネルへ書き込んでください）`, embeds: [], components: [] })
  const text = await awaitReply(channelID, requesterID)
  if (text === null) throw new StopDrafting('時間内に入力がなかったため、作成を取りやめました。')
  return text
}

// The ask_user tool: the model's question as buttons, a way to answer in words, and a way out.
function asker (reply, channelID, requesterID) {
  return async (question, options) => {
    const picked = await choose(reply, requesterID, {
      content: '',
      embeds: [{ title: '確認させてください', description: question, color: EMBED_COLORS.YELLOW_ORANGE }]
    }, [
      ...options.map(label => ({ label, style: PRIMARY })),
      { label: 'その他（文字で入力）', style: SECONDARY },
      { label: 'やめる', style: SECONDARY }
    ])
    if (!picked) throw new StopDrafting('時間内に回答がなかったため、作成を取りやめました。')
    if (picked.index === options.length + 1) throw new StopDrafting('作成をやめました。')
    const answer = picked.index === options.length
      ? await typedAnswer(reply, channelID, requesterID, `「${question}」への答えを入力してください`)
      : options[picked.index]
    await reply.edit({ content: `「${answer.slice(0, 100)}」で続けます…`, embeds: [], components: [] })
    return answer
  }
}

async function handle (message) {
  if (takeReply(message)) return
  if (!isMentioned(message)) return
  const guild = message.channel.guild
  const reference = { messageReference: { messageID: message.id, failIfNotExists: false } }

  if (!isConfigured()) {
    // Say why nothing happens, but only to staff: for everyone else the feature simply isn't there.
    const missing = missingSettings()
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      global.logger.warn(`Mention drafting is disabled: ${missing.join(', ')} not set`)
    }
    if (!canUseAssistant(message.member, guild)) return
    return message.channel.createMessage({ content: `メンション機能が設定されていないため使えません（未設定: ${missing.join(', ')}）。`, ...reference }).catch(() => {})
  }
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
    const tools = createTools({
      guild,
      member,
      ask: asker(reply, message.channel.id, message.author.id),
      progress: text => reply.edit({ content: text }).catch(() => {})
    })
    // A mention sent as a reply ("@bot これをイベントにして") is about the replied-to message.
    const referenced = repliedTo
      ? await tools.readMessage(message.messageReference.channelID || message.channel.id, repliedTo).catch(e => `（読めませんでした: ${e.message}）`)
      : null
    // Fetched fresh for every request. Without it the draft still works, just with less context.
    const server = await describeServer(guild, member, message.channel.id).catch(e => {
      global.logger.warn(`Could not describe server ${guild.id}: ${e.message}`)
      return null
    })
    let result = await draft({
      request,
      referenced,
      channelName: message.channel.name,
      channelID: message.channel.id,
      server,
      forum: namedForum(message),
      images: attachedImages(message),
      guild,
      member,
      tools
    })
    let revisions = 0
    let cover = null
    let needsCover = true
    for (;;) {
      if (result.error) {
        await editReply(reply, { content: `作成できませんでした: ${result.error}`, embeds: [], components: [] }, null)
        return
      }

      const kind = KINDS[result.kind]
      if (needsCover) {
        // A correction can switch between event and forum post, which use different sizes.
        if (!cover || cover.size !== kind.size) cover = new CoverImage(kind.size)
        await cover.useDraft({ imageUrl: result.imageUrl, ...kind.text(result) })
        needsCover = false
      }
      const embed = kind.preview(result, [...new Set(tools.sources)], message.author, cover)
      const canRevise = revisions < MAX_REVISIONS
      const buttons = [
        { label: kind.confirmLabel, style: SUCCESS, action: 'create' },
        ...(canRevise ? [{ label: '修正する', style: PRIMARY, action: 'revise' }] : []),
        { label: 'キャンセル', style: DANGER, action: 'cancel' },
        ...cover.modes().map(mode => ({
          label: `画像: ${MODES[mode]}`,
          style: mode === cover.mode ? SUCCESS : SECONDARY,
          action: `image:${mode}`,
          row: 1
        }))
      ]
      const picked = await choose(reply, message.author.id, { content: canRevise ? '' : `修正は${MAX_REVISIONS}回までです。`, embeds: [embed] }, buttons, cover.buffer)
      if (!picked) {
        await reply.edit({ content: '時間内に確認されなかったため、取りやめました。', components: [] })
        return
      }
      const { interaction } = picked
      const action = buttons[picked.index].action
      if (action === 'cancel') {
        await interaction.editOriginalMessage({ content: 'キャンセルしました。', components: [] })
        return
      }
      if (action === 'create') {
        await interaction.editOriginalMessage({ content: await kind.create(result, guild, message.author, cover), components: [] })
        return
      }
      if (action.startsWith('image:')) {
        const mode = action.slice('image:'.length)
        if (mode === 'ai' && !cover.rendered.has('ai')) await reply.edit({ content: 'AI で画像を作成しています…', components: [] })
        await cover.select(mode)
        continue
      }
      const correction = await typedAnswer(reply, message.channel.id, message.author.id, '直したい内容を入力してください（例: 開始は20時、場所はボイスチャンネル）')
      await reply.edit({ content: '修正を反映しています…' })
      result = await revise(result.conversation, correction)
      revisions++
      needsCover = true
    }
  } catch (e) {
    if (e instanceof StopDrafting) {
      await editReply(reply, { content: e.message, embeds: [], components: [] }, null).catch(() => {})
      return
    }
    global.logger.error(e)
    // The console log alone is easy to miss; also send it to the error webhook the operators watch.
    global.webhook.error(redact(`Drafting from a mention in ${guild.id} failed: ${e.message}`).slice(0, 2000))
    const cause = e.hint || (e.name === 'TimeoutError' ? 'AI の応答が時間内に返りませんでした' : null)
    const content = `作成中にエラーが発生しました${cause ? `（${cause}）` : ''}。時間をおいてもう一度お試しください。\n${errorLog(e)}`
    if (reply) {
      await editReply(reply, { content, embeds: [], components: [] }, null).catch(() => {})
    } else {
      await message.channel.createMessage({ content, ...reference }).catch(() => {})
    }
  } finally {
    inProgress.delete(message.author.id)
  }
}

module.exports = { handle, extractRequest }
