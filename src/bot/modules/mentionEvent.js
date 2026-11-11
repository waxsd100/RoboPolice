const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { draft, revise, isConfigured, isUncensoredConfigured, isUncensoredDirective, rememberThreadModel, isR18Text, STORY_REQUEST_PATTERN, ENTITY_TYPES } = require('./eventDrafter')
const { createTools, describeServer, worthSearching, withServerEmojis, withServerChannels, StopDrafting } = require('./eventTools')
const { embedQuery } = require('../utils/embeddings')
const { withLinkCards } = require('../utils/linkCards')
const { safeLinks } = require('../utils/linkSafety')
const { reportInjection } = require('../utils/untrusted')
const { picturesFor, attachedPictures } = require('../utils/foreignEmojis')
const { EMBED_COLORS } = require('../utils/constants')
const { hasStaffAccess } = require('../utils/staffAccess')
const { isCreator } = require('../utils/creatorIds')
const { redact } = require('../utils/redact')
const { trackUsage, tokenFooter } = require('../utils/geminiUsage')
const { polish } = require('./replyPolish')
const { relatedRecent } = require('./recentTopics')
const mentionQuota = require('../utils/mentionQuota')
const { SIZES } = require('../utils/imageCrop')
const { CoverImage, MODES } = require('./coverImage')
const { FORUM_TYPES } = require('./forumPost')
const postedEdit = require('./postedEdit')
const replySettingsStore = require('../../db/interfaces/postgres/replySettings')
const mentionLogsStore = require('../../db/interfaces/postgres/mentionLogs')
const { EDIT_HINT } = postedEdit

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
// channel is the answer (a correction, a free-text reply to a question, or what to do with the
// image, which may be an attached image alone).
const waitingReplies = new Map()

// Resolves to { text, images } (images: URLs of attached images, only when `withImages`), or null
// after the timeout.
function awaitReply (channelID, userID, { withImages = false } = {}) {
  const key = `${channelID}:${userID}`
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      waitingReplies.delete(key)
      resolve(null)
    }, ANSWER_TIMEOUT_MS)
    waitingReplies.set(key, {
      withImages,
      resolve: answer => {
        clearTimeout(timer)
        waitingReplies.delete(key)
        resolve(answer)
      }
    })
  })
}

// Hands `message` to a waiting awaitReply(), if it is the answer one is waiting for.
function takeReply (message) {
  const waiting = waitingReplies.get(`${message.channel.id}:${message.author.id}`)
  if (!waiting || isMentioned(message)) return false
  const text = message.content.trim()
  const images = waiting.withImages ? attachedImages(message) : []
  if (!text && !images.length) return false
  waiting.resolve({ text, images })
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
// message, so it is not used.
function isMentioned (message) {
  const guild = message.channel.guild
  return [...message.content.matchAll(mentionPattern())].some(m => !m[1] || isOwnRole(guild, m[1]))
}

// A Discord reply (with the mention turned off) to one of the bot's own answers: the bot's
// messages that are themselves replies, so not its logs (posted through webhooks) or other posts.
function repliesToBot (message) {
  const ref = message.referencedMessage
  return !!(message.messageReference && ref && ref.author?.id === global.bot.user.id && !ref.webhookID && ref.messageReference)
}

const MAX_MESSAGE = 2000

// Splits a long chat/novel reply (> 2,000 chars) at paragraph or sentence boundaries so the whole
// story is delivered across consecutive Discord messages without truncation.
function splitChatMessages (content, footer) {
  const s = String(content || '')
  const roomWithFooter = footer ? MAX_MESSAGE - footer.length - 1 : MAX_MESSAGE
  if (s.length <= roomWithFooter) {
    return [footer ? `${s}\n${footer}` : s]
  }
  const chunks = []
  let rest = s
  while (rest.length > 0) {
    if (rest.length <= roomWithFooter) {
      chunks.push(footer ? `${rest}\n${footer}` : rest)
      break
    }
    if (rest.length <= MAX_MESSAGE) {
      chunks.push(rest)
      if (footer) chunks.push(footer)
      break
    }
    const slice = rest.slice(0, MAX_MESSAGE)
    let cut = slice.lastIndexOf('\n\n')
    if (cut < MAX_MESSAGE * 0.4) cut = slice.lastIndexOf('\n')
    if (cut < MAX_MESSAGE * 0.4) {
      const m = [...slice.matchAll(/[。！？…」』]\s*/g)].at(-1)
      if (m && m.index + m[0].length >= MAX_MESSAGE * 0.4) cut = m.index + m[0].length
    }
    if (cut < MAX_MESSAGE * 0.4) cut = MAX_MESSAGE
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  return chunks
}

// A chat reply's text with only the links that came up in the conversation (the request, what it
// replies to, what the tools read): linkSafety.js. Links left out are logged.
function checkedText (text, result, guild) {
  if (!text) return text
  const { text: clean, removed } = safeLinks(text, result.conversation?.contents, result.conversation?.toolUrls)
  if (removed.length) global.logger.warn(`[INJECTION]: Left out link(s) that came from nowhere in a reply in ${guild.id}: ${removed.join(' ').slice(0, 300)}`)
  return clean
}

function checkedLinks (result, guild) {
  return checkedText(result.text, result, guild)
}

function checkedDraft (result, guild) {
  if (result.kind === 'event' && result.event) {
    const description = checkedText(result.event.description, result, guild)
    const location = result.event.entity_metadata?.location
      ? checkedText(result.event.entity_metadata.location, result, guild)
      : undefined
    return {
      ...result,
      event: {
        ...result.event,
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { entity_metadata: { ...result.event.entity_metadata, location } } : {})
      }
    }
  }
  if (result.kind === 'forum' && result.post?.message?.content) {
    return {
      ...result,
      post: {
        ...result.post,
        message: {
          ...result.post.message,
          content: checkedText(result.post.message.content, result, guild)
        }
      }
    }
  }
  return result
}

// Talking to the bot: mentioning it, or replying to its answer.
function isAddressed (message) {
  return isMentioned(message) || repliesToBot(message)
}

let warnedUnconfigured = false
function missingSettings () {
  if (process.env.CLOUDFLARE_AI_GATEWAY_URL) return []
  return ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_GATEWAY_ID'].filter(name => !process.env[name])
}

// Anyone can talk with the bot. What a request makes is checked when it is made: an event needs
// Manage Events (or the owner, an administrator, staff, or a CREATOR_IDS user), a forum post needs permission to post
// in that forum (checked in forumPost.js).
const NO_EVENT_PERMISSION = 'イベントを登録・変更するには「イベントの管理」権限が必要です。'

function canManageEvents (member, guild) {
  return member.id === guild.ownerID ||
    member.permissions.has('manageEvents') ||
    member.permissions.has('administrator') ||
    hasStaffAccess(member.roles, guild) ||
    isCreator(member.id)
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
    .filter(a => /^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp|gif|avif)(?:[?#]|$)/i.test(a.filename || a.url || ''))
    .map(a => a.url)
}

function embeddedImages (message) {
  const urls = []
  for (const e of message.embeds || []) {
    for (const img of [e?.image, e?.thumbnail]) {
      if (img?.url && !urls.includes(img.url)) urls.push(img.url)
    }
  }
  return urls
}

function extractRequest (message) {
  const guild = message.channel.guild
  return message.content
    .replace(mentionPattern(), (whole, roleID) => !roleID || isOwnRole(guild, roleID) ? '' : whole)
    .trim()
}

// What the bot says in a chat reply comes from the model; it must never ping anyone.
const NO_MENTIONS = { everyone: false, roles: false, users: false }

// A draft that could not be made: marked so it is not mistaken for a chat reply.
function failure (reason) {
  return `⚠️ **作成できませんでした**\n${reason}`
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
const CANDIDATES_IMAGE = 'candidates.jpg'

function coverParts (cover) {
  return {
    fields: [{ name: '画像', value: cover.describe() }],
    image: cover.buffer ? { url: `attachment://${PREVIEW_IMAGE}` } : undefined
  }
}

// The candidates side by side, as a second embed under the draft, when there is more than one.
function candidatesEmbed (cover) {
  if (!cover.sheet) return []
  return [{
    title: '画像の候補',
    description: '左上から 画像1・画像2・画像3・画像4。黄色の枠が選択中です。下の「画像」ボタンで選べます。',
    color: EMBED_COLORS.YELLOW_ORANGE,
    image: { url: `attachment://${CANDIDATES_IMAGE}` }
  }]
}

// The files the preview shows: the cover as it will be set, and the candidate sheet.
function previewFiles (cover) {
  return [
    ...(cover.buffer ? [{ filename: PREVIEW_IMAGE, file: cover.buffer }] : []),
    ...(cover.sheet ? [{ filename: CANDIDATES_IMAGE, file: cover.sheet }] : [])
  ]
}

// Where an edit says which fields it changes, so the requester can see nothing else is touched.
function changesField (changed) {
  if (!changed) return []
  return [{ name: '変更する項目', value: changed.length ? changed.join('、') : '（文章の変更なし）' }]
}

function eventPreview ({ event, endGuessed }, sources, requester, cover, { confirmLabel, changed }) {
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
      ...changesField(changed),
      ...image.fields,
      ...sourcesField(sources)
    ],
    image: image.image,
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「${confirmLabel}」を押してください` }
  }
}

function forumPreview ({ post, tagNames, truncated }, sources, requester, cover, { confirmLabel, changed }) {
  const image = coverParts(cover)
  return {
    title: post.name,
    description: post.message.content,
    color: EMBED_COLORS.GREEN,
    fields: [
      { name: '投稿先', value: `<#${post.channelID}>`, inline: true },
      { name: 'タグ', value: tagNames.join(', ') || 'なし', inline: true },
      ...(truncated ? [{ name: '注意', value: '本文が2000文字を超えたため、超えた分は切り捨てます。' }] : []),
      ...changesField(changed),
      ...image.fields,
      ...sourcesField(sources)
    ],
    image: image.image,
    footer: { text: `${requester.username} さんの依頼 ・ この内容でよければ「${confirmLabel}」を押してください` }
  }
}

// What each kind of draft looks like and how it is created once the requester confirms.
const KINDS = {
  event: {
    preview: eventPreview,
    confirmLabel: '登録する',
    revisePrompt: 'イベントの内容（名前・日時・場所・説明）で直したいことを入力してください。画像は「画像」のボタンで変えられます（例: 開始は20時、場所はボイスチャンネル）',
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
      return `イベントを登録しました: https://discord.com/events/${guild.id}/${created.id}\n${EDIT_HINT}`
    }
  },
  forum: {
    preview: forumPreview,
    confirmLabel: '投稿する',
    revisePrompt: '投稿の内容（題名・本文・タグ・投稿先）で直したいことを入力してください。画像は「画像」のボタンで変えられます（例: 題名に日付を入れて、タグは募集中）',
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
      return `フォーラムに投稿しました: https://discord.com/channels/${guild.id}/${thread.id}\n${EDIT_HINT}`
    }
  }
}

// Edits the reply. With `files` ([{ filename, file }], or null to remove all) the edit goes through
// the REST API directly: the pinned Eris cannot attach files when editing a message.
async function editReply (reply, payload, files) {
  if (files === undefined) return reply.edit(payload)
  const list = files || []
  const { allowedMentions, ...body } = payload
  return global.bot.requestHandler.request('PATCH', `/channels/${reply.channel.id}/messages/${reply.id}`, true, {
    ...body,
    // The REST API's own name for it; nothing the bot edits in should ping anyone.
    allowed_mentions: { parse: [] },
    attachments: list.map((f, id) => ({ id, filename: f.filename }))
  }, list.length ? list.map((f, i) => ({ name: `files[${i}]`, file: f.file })) : undefined)
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
async function choose (reply, requesterID, message, buttons, files) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const ids = buttons.map(() => uuidv4())
  await editReply(reply, { ...message, components: buttonRows(buttons, ids) }, files)
  try {
    const interaction = await Promise.race(ids.map(id => awaitCustomID(id, requesterID, ANSWER_TIMEOUT_MS)))
    return { index: ids.indexOf(interaction.data.custom_id), interaction }
  } catch (_) {
    return null
  } finally {
    ids.forEach(cancelCustomID)
  }
}

// Asks the requester to type their answer as their next message in the channel. Resolves to the
// text, or with `withImages` to { text, images }.
async function typedAnswer (reply, channelID, requesterID, prompt, { withImages = false } = {}) {
  await reply.edit({ content: `${prompt}（5分以内にこのチャンネルへ書き込んでください）`, embeds: [], components: [] })
  const answer = await awaitReply(channelID, requesterID, { withImages })
  if (answer === null) throw new StopDrafting('時間内に入力がなかったため、作成を取りやめました。')
  return withImages ? answer : answer.text
}

const IMAGE_PROMPT = '画像をどう変えるか入力してください。画像の URL を書くか画像を添付すると、その画像に差し替えます（例: 背景を夜空にして、もっと明るく、人物を消して）'
// AI image edits per draft: each is an image model call.
const MAX_IMAGE_INSTRUCTIONS = 5

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
  if (!isAddressed(message)) return
  const guild = message.channel.guild
  const reference = { messageReference: { messageID: message.id, failIfNotExists: false } }

  if (!isConfigured()) {
    // Say why nothing happens, but only to staff: for everyone else the feature simply isn't there.
    const missing = missingSettings()
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      global.logger.warn(`Mention drafting is disabled: ${missing.join(', ')} not set`)
    }
    if (!canManageEvents(message.member, guild)) return
    return message.channel.createMessage({ content: `メンション機能が設定されていないため使えません（未設定: ${missing.join(', ')}）。`, ...reference }).catch(() => {})
  }

  let request = extractRequest(message)
  const attached = attachedImages(message)
  const embedded = embeddedImages(message)
  const repliedTo = message.messageReference?.messageID
  if (!request && !repliedTo && !attached.length && !embedded.length) {
    return message.channel.createMessage({ content: '話したいことか、イベントやフォーラム投稿にしたい内容（文章・URL・メッセージリンク）を添えるか、元のメッセージに返信する形でメンションしてください。', ...reference }).catch(() => {})
  }
  if (inProgress.has(message.author.id)) {
    return message.channel.createMessage({ content: '前の依頼を処理中です。終わってからもう一度お試しください。', ...reference }).catch(() => {})
  }

  inProgress.add(message.author.id)
  // Every Gemini request made for this mention is counted, and logged when it is done.
  await trackUsage(async usage => {
    let reply
    let referenced = null
    let outcome = null
    try {
      reply = await message.channel.createMessage({ content: '内容を読み取っています…', ...reference })
      // /replylength, /persona, %debugfooter, %tokenlimit, %safety; without them (or the database) as by default.
      const { isOwnerGuild } = require('../utils/priority')
      const owner = isOwnerGuild(guild.id)
      const { replyLength, streamerPersona, debugFooter, tokenLimits, replyModel, replyThinking, aiModels, assistantRules, safety = {}, safetyFilter = !owner, uncensoredR18 = owner } = await replySettingsStore.getReplySettings(guild.id)
        .catch(() => ({ replyLength: null, streamerPersona: true, debugFooter: false, tokenLimits: {}, safety: {}, safetyFilter: !owner, uncensoredR18: owner }))
      const allowUncensored = uncensoredR18 !== false || (safetyFilter === false && safety?.uncensored !== false)
      // Per user across every server, in tokens, against this server's limits (mentionQuota.js). Near
      // a limit, every call goes to Flex inference: slower and half the price.
      const quota = await mentionQuota.take(message.author.id, guild.id, new Date(), { limits: tokenLimits })
      if (!quota.allowed) throw new StopDrafting(mentionQuota.refusal(quota))
      if (quota.flex) {
        usage.flex = true
        await reply.edit({ content: `利用量が上限の ${Math.floor(quota.used * 100)}% に近づいたので、低速モード（Flex）で考えています…（数分かかることがあります）` }).catch(() => {})
      }
      usage.onWait = ms => reply.edit({ content: `AI が混み合っているため、${Math.ceil(ms / 1000)} 秒待ってから再試行します…` }).catch(() => {})
      const member = message.member
      const tools = createTools({
        guild,
        member,
        ask: asker(reply, message.channel.id, message.author.id),
        progress: text => reply.edit({ content: text }).catch(() => {})
      })
      // Replying to something the bot made (or to the message saying it did) is a request to change it.
      const editTarget = repliedTo
        ? await postedEdit.findTarget(guild, message.messageReference.channelID || message.channel.id, repliedTo)
        : null
      if (editTarget && !request && !attached.length) throw new StopDrafting('直したいこと（例: 開始を20時に、題名に日付を入れて）を書くか、差し替える画像を添付してメンションしてください。')
      // An image attached to the reply is what the image is to be replaced with.
      if (editTarget && !request) request = '画像を添付の画像に差し替えて'
      if (editTarget?.kind === 'event' && !canManageEvents(message.member, guild)) throw new StopDrafting(failure(NO_EVENT_PERMISSION))
      const edit = editTarget && await postedEdit.load(guild, editTarget)
      // A mention sent as a reply ("@bot これをイベントにして") is about the replied-to message.
      // Following the replies back makes a reply to the bot's answer continue that conversation.
      referenced = repliedTo && !edit
        ? await tools.readThread(message.messageReference.channelID || message.channel.id, repliedTo).catch(e => ({ text: `（読めませんでした: ${e.message}）`, count: 1 }))
        : null
      // Attempts to take over the model are only logged: the prompt marks all of this as data.
      reportInjection(`a mention by ${message.author.id} in ${guild.id}`, request)
      if (referenced) reportInjection(`the conversation a mention in ${guild.id} replies to`, referenced.text)
      // Fetched fresh for every request. Without it the draft still works, just with less context.
      // Knowledge is looked up by what the members said, not the bot's own earlier replies.
      // What was just being talked about in the channel, as far as it bears on the request
      // (recentTopics.js); not when something the bot made is being changed.
      // The server's rules and what its moderators asked of the assistant (serverRules.js).
      const directR18 = allowUncensored && isUncensoredConfigured() && (isUncensoredDirective(request, referenced) || isR18Text(request, referenced?.text))
      let queryVecPromise = null
      const queryVector = () => {
        if (!worthSearching(request)) return Promise.resolve(null)
        if (!queryVecPromise) queryVecPromise = embedQuery(request)
        return queryVecPromise
      }
      const combinedQuery = [request, referenced?.othersText].filter(Boolean).join('\n')
      const communityKeyword = /サーバー|チャンネル|配信|動画|youtube|twitch|steam|ゲーム|イベント|フォーラム|ルール|wiki|メンバー|キャラ|名言|<#\d+>|<@!?\d+>/i
      const slimProfile = Boolean(edit) ||
        (!worthSearching(combinedQuery) && !attached.length && !embedded.length) ||
        (STORY_REQUEST_PATTERN.test(request) && !communityKeyword.test(combinedQuery))
      const [server, recent] = await Promise.all([
        directR18
          ? null
          : describeServer(guild, member, message.channel.id, { query: request, context: referenced?.othersText, queryVector, slim: slimProfile }).catch(e => {
            global.logger.warn(`Could not describe server ${guild.id}: ${e.message}`)
            return null
          }),
        (edit || referenced)
          ? []
          : relatedRecent(message, request, { queryVector }).catch(e => {
            global.logger.warn(`Could not read the recent talk in ${message.channel.id}: ${e.message}`)
            return []
          })
      ])
      // Combined emojis, other servers' emojis, and attached/replied-to images in what was said are
      // shown to the model as images, for this request only.
      const threadImages = edit ? [] : [...new Set([...attached, ...embedded, ...(referenced?.images || [])])]
      const pictures = directR18
        ? await attachedPictures(threadImages).catch(() => [])
        : await picturesFor([request, referenced?.text], guild, threadImages).catch(() => [])
      // A reply brings its conversation in (`referenced`); otherwise only what was just said in the
      // channel that bears on the request (`recent`), never the bot's own earlier replies.
      let result = await draft({
        request,
        referenced,
        recent,
        replyLength,
        streamerPersona,
        safetyFilter: !!safetyFilter,
        uncensoredR18: allowUncensored,
        rules: directR18 ? null : { moderators: assistantRules || null, channels: [] },
        model: replyModel || null,
        thinking: replyThinking || null,
        tier: aiModels?.reply?.tier || null,
        channelName: message.channel.name,
        channelID: message.channel.id,
        server,
        forum: namedForum(message),
        images: attached,
        pictures,
        edit,
        guild,
        member,
        tools
      })
      let revisions = 0
      let cover = null
      let needsCover = true
      let imageInstructions = 0
      let lastInstruction = null
      let replacedWithAttachment = false
      let previous = null // the draft shown before the latest correction
      let note = ''
      for (;;) {
        if (result.kind === 'chat') {
          if (!previous) {
            // Rewritten to read less like AI-made Japanese (replyPolish.js), but not what the
            // stronger model or the uncensored fallback wrote.
            if (!result.conversation?.contents?.deep && !result.conversation?.contents?.uncensored) result = { ...result, text: await polish(result.text, { guildID: guild.id }) }
            const { content, embeds } = await withLinkCards(withServerChannels(withServerEmojis(checkedLinks(result, guild), guild), guild, message.member))
            outcome = { kind: 'chat', response: content }
            const chunks = splitChatMessages(content, debugFooter ? tokenFooter(usage) : '')
            await reply.edit({ content: chunks[0], embeds: chunks.length === 1 ? embeds : [], components: [], allowedMentions: NO_MENTIONS })
            const sentIds = [message.id, reply?.id]
            let prevId = reply?.id || message.id
            for (let i = 1; i < chunks.length; i++) {
              const followUp = await message.channel.createMessage({
                content: chunks[i],
                embeds: i === chunks.length - 1 ? embeds : [],
                messageReference: { messageID: prevId },
                allowedMentions: NO_MENTIONS
              })
              if (followUp?.id) {
                sentIds.push(followUp.id)
                prevId = followUp.id
              }
            }
            rememberThreadModel(sentIds, result.conversation?.contents)
            return
          }
          // The requester asked something about the draft instead of correcting it: answer, and
          // show the draft again.
          note = withServerChannels(withServerEmojis(checkedLinks(result, guild), guild), guild, message.member)
          result = { ...previous, conversation: result.conversation }
          continue
        }
        if (!result.error && result.kind === 'event' && !canManageEvents(message.member, guild)) {
          result = { ...result, error: NO_EVENT_PERMISSION }
        }
        if (result.error) {
          const errContent = failure(result.error)
          outcome = { kind: 'error', response: errContent }
          await editReply(reply, { content: errContent, embeds: [], components: [] }, null)
          return
        }
        result = checkedDraft(result, guild)

        const kind = KINDS[result.kind]
        if (!cover) {
          cover = new CoverImage(kind.size, { current: edit?.image })
          await cover.useDraft({ imageUrls: result.imageUrls, ...kind.text(result) })
        } else if (needsCover) {
          // Corrections are about the text: the image stays as it was. Switching between event and
          // forum post changes only its size.
          if (cover.size !== kind.size) await cover.resize(kind.size)
          await cover.revise({ imageUrls: result.imageUrls, ...kind.text(result) })
        }
        // An instruction about the image in the request or a correction ("背景を夜空に"). The model
        // may repeat it when revising, so only a new one is applied.
        if (!replacedWithAttachment && edit && attached.length) {
          // Changing something already posted: the attached image replaces its image, whatever the
          // model made of the request. Its instruction for this draft is then already carried out.
          replacedWithAttachment = true
          lastInstruction = result.imageInstruction
          await cover.instruct({ images: attached.slice(0, 1) })
        }
        if (needsCover && result.imageInstruction && result.imageInstruction !== lastInstruction && imageInstructions < MAX_IMAGE_INSTRUCTIONS) {
          lastInstruction = result.imageInstruction
          imageInstructions++
          await reply.edit({ content: '画像を変更しています…', embeds: [], components: [] })
          await cover.instruct({ text: result.imageInstruction })
        }
        needsCover = false
        const confirmLabel = edit ? '更新する' : kind.confirmLabel
        const embed = kind.preview(result, [...new Set(tools.sources)], message.author, cover, {
          confirmLabel,
          changed: edit ? postedEdit.changes(edit, result) : null
        })
        const canRevise = revisions < MAX_REVISIONS
        const buttons = [
          { label: confirmLabel, style: SUCCESS, action: 'create' },
          ...(canRevise ? [{ label: '内容を修正', style: PRIMARY, action: 'revise' }] : []),
          ...(imageInstructions < MAX_IMAGE_INSTRUCTIONS ? [{ label: '画像を指示で変更', style: PRIMARY, action: 'instruct' }] : []),
          { label: 'キャンセル', style: DANGER, action: 'cancel' },
          // Which candidate, then how it becomes the image: separate rows, so it is clear these
          // buttons are about the image and 内容を修正 is about the text.
          ...(cover.candidates.length > 1
            ? cover.candidates.map((_, i) => ({
              label: `画像${i + 1}`,
              style: cover.usesCandidate() && i === cover.selected ? SUCCESS : SECONDARY,
              action: `candidate:${i}`,
              row: 1
            }))
            : []),
          ...cover.modes().map(mode => ({
            label: `画像: ${mode === 'ai' && cover.mode === 'ai' ? 'AIで作り直す' : MODES[mode]}`,
            style: mode === cover.mode ? SUCCESS : SECONDARY,
            action: `image:${mode}`,
            row: 2
          }))
        ]
        const picked = await choose(reply, message.author.id, {
          content: [note.slice(0, 1500), canRevise ? '' : `内容の修正は${MAX_REVISIONS}回までです。`].filter(Boolean).join('\n\n'),
          allowedMentions: NO_MENTIONS,
          embeds: [embed, ...candidatesEmbed(cover)]
        }, buttons, previewFiles(cover))
        if (!picked) {
          const timeoutContent = '時間内に確認されなかったため、取りやめました。'
          outcome = { kind: 'cancelled', response: timeoutContent }
          await reply.edit({ content: timeoutContent, components: [] })
          return
        }
        const { interaction } = picked
        const action = buttons[picked.index].action
        if (action === 'cancel') {
          const cancelContent = 'キャンセルしました。'
          outcome = { kind: 'cancelled', response: cancelContent }
          await interaction.editOriginalMessage({ content: cancelContent, components: [] })
          return
        }
        if (action === 'create') {
          const done = edit
            ? await postedEdit.update(guild, edit, result, cover, message.author)
            : await kind.create(result, guild, message.author, cover)
          outcome = { kind: result.kind, response: done }
          await interaction.editOriginalMessage({ content: done, components: [] })
          return
        }
        if (action.startsWith('candidate:') || action.startsWith('image:')) {
          if (action === 'image:ai' && cover.needsAiRender()) await reply.edit({ content: 'AI で画像を作成しています…', components: [] })
          await cover.pick(action)
          continue
        }
        if (action === 'instruct') {
          const answer = await typedAnswer(reply, message.channel.id, message.author.id, IMAGE_PROMPT, { withImages: true })
          imageInstructions++
          await reply.edit({ content: '画像を変更しています…' })
          await cover.instruct(answer)
          continue
        }
        const correction = await typedAnswer(reply, message.channel.id, message.author.id, kind.revisePrompt)
        await reply.edit({ content: '修正を反映しています…' })
        previous = result
        note = ''
        result = await revise(result.conversation, correction)
        revisions++
        needsCover = true
      }
    } catch (e) {
      if (e instanceof StopDrafting || e instanceof postedEdit.EditRefused) {
        outcome = { kind: 'refused', response: e.message }
        await editReply(reply, { content: e.message, embeds: [], components: [] }, null).catch(() => {})
        return
      }
      // Google refused to answer (its own filters, which no setting turns off): not a fault of the
      // bot, so no error, log dump or webhook; the requester is told in a line, in character.
      if (e.blocked) {
        global.logger.info(`[GEMINI]: A mention in ${guild.id} was refused by Google (${e.blocked})`)
        const content = 'ごめん、その内容は AI（Google）の制限で答えられなかった…！言い方や中身を変えてもう一回どうぞ。'
        outcome = { kind: 'refused', response: content }
        if (reply) await editReply(reply, { content, embeds: [], components: [] }, null).catch(() => {})
        else await message.channel.createMessage({ content, ...reference }).catch(() => {})
        return
      }
      global.logger.error(e)
      // The console log alone is easy to miss; also send it to the error webhook the operators watch.
      global.webhook.error(redact(`Drafting from a mention in ${guild.id} failed: ${e.message}`).slice(0, 2000))
      const cause = e.hint || (e.name === 'TimeoutError' ? 'AI の応答が時間内に返りませんでした' : null)
      const content = `⚠️ エラーが発生しました${cause ? `（${cause}）` : ''}。時間をおいてもう一度お試しください。\n${errorLog(e)}`
      outcome = { kind: 'error', response: content }
      if (reply) {
        await editReply(reply, { content, embeds: [], components: [] }, null).catch(() => {})
      } else {
        await message.channel.createMessage({ content, ...reference }).catch(() => {})
      }
    } finally {
      inProgress.delete(message.author.id)
      // Whatever it ended in, the tokens it used count against the user's limits.
      await mentionQuota.record(message.author.id, usage.cost)
      if (outcome) {
        await mentionLogsStore.saveMentionLog({
          guildID: guild.id,
          channelID: message.channel.id,
          messageID: message.id,
          replyMessageID: reply?.id || null,
          userID: message.author.id,
          userName: message.author.username || null,
          kind: outcome.kind,
          request: request || '',
          referencedText: referenced?.text || null,
          response: outcome.response,
          model: usage.models?.length ? usage.models.join(' → ') : null,
          promptTokens: usage.tokens?.prompt || 0,
          cachedTokens: usage.tokens?.cached || 0,
          outputTokens: usage.tokens?.output || 0,
          thinkingTokens: usage.tokens?.thoughts || 0,
          geminiCalls: usage.requests || 0
        }).catch(err => global.logger.warn(`Could not save mention log in ${guild.id}: ${err.message}`))
      }
      global.logger.info(`Mention drafting in ${guild.id}: ${usage.requests} Gemini request(s), ${usage.retries} retried after HTTP 429`)
    }
  })
}

module.exports = { handle, extractRequest }
