// Messages written into a channel from a mention ("#お知らせ に〇〇って書き込んで"): the submit
// tool the model fills in, who may ask for one, and the checks that turn its answer into a Discord
// "create message" request.
//
// The bot speaks for the server here, so only moderators and above may ask (canPostAsBot); the
// requester and the bot must also both be able to write in the channel.

const { withoutCharCount } = require('../utils/textClean')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { IMAGE_INSTRUCTION_PROPERTY, imageUrlsOf, imageInstructionOf, safePermissionsOf, MAX_IMAGE_CANDIDATES } = require('./forumPost')

// Text, announcement, and the three thread types. Forums and voice/stage chats are not offered: a
// forum takes a post (forumPost.js), not a message.
const TEXT_TYPES = [0, 5]
const THREAD_TYPES = [10, 11, 12]
const POSTABLE_TYPES = [...TEXT_TYPES, ...THREAD_TYPES]
const MAX_CONTENT = 2000

// What makes someone a moderator: any of the permissions a moderator role is given. The owner,
// administrators, staff (STAFF_ROLE_ID and above) and the bot's creators count as more than that.
const MODERATOR_PERMISSIONS = ['manageGuild', 'manageMessages', 'moderateMembers', 'kickMembers', 'banMembers']

const NO_POST_PERMISSION = 'BOT にチャンネルへ書き込ませるには、モデレーター以上（「メッセージの管理」「メンバーをタイムアウト」などの権限）が必要です。'

function canPostAsBot (member, guild) {
  if (!member || !guild) return false
  return member.id === guild.ownerID ||
    member.permissions?.has('administrator') ||
    MODERATOR_PERMISSIONS.some(p => member.permissions?.has(p)) ||
    hasStaffAccess(member.roles, guild) ||
    isCreator(member.id)
}

const SUBMIT_CHANNEL_POST_DECLARATION = {
  name: 'submit_channel_message_draft',
  description: 'BOT として特定のチャンネルにメッセージを書き込む（「#お知らせ に〇〇と書いて」「〇〇チャンネルにこれを投稿して」など）よう頼まれたとき、調べ終わったら必ず最後に1回だけ呼ぶ。書き込む内容の下書き、または作れない理由を提出する。フォーラムへの投稿は submit_forum_post_draft を使う。',
  parameters: {
    type: 'OBJECT',
    properties: {
      found: { type: 'BOOLEAN', description: '書き込み先のチャンネルと、書き込む本文を決められたか' },
      reason: { type: 'STRING', description: 'found が false のとき、何が足りないかを利用者向けに日本語で一文' },
      channel_id: { type: 'STRING', description: '書き込み先のチャンネルの ID（依頼の <#ID>、または list_channels で確認したもの。テキスト・アナウンス・スレッドのみ）' },
      content: { type: 'STRING', description: `書き込む本文（${MAX_CONTENT}文字以内、Discord の Markdown 可）。依頼者が文面を指定したときはその文面を変えずにそのまま入れる。指定がなく内容だけ頼まれたときは、その内容で文面を作る` },
      image_urls: { type: 'ARRAY', items: { type: 'STRING' }, description: `添える画像の候補 URL（良い順、最大${MAX_IMAGE_CANDIDATES}つ）。依頼者が画像を添えるよう頼んだとき、または添付・参照した画像を一緒に載せるべきときだけ。なければ空` },
      image_instruction: IMAGE_INSTRUCTION_PROPERTY
    },
    required: ['found']
  }
}

function isThread (channel) {
  return THREAD_TYPES.includes(channel?.type)
}

// Viewing and writing; in a thread writing is "send messages in threads", and a locked or archived
// thread is left to Discord to refuse.
function canWrite (channel, memberOrId) {
  const perms = safePermissionsOf(channel, memberOrId)
  if (!perms || !perms.has('viewChannel')) return false
  return perms.has(isThread(channel) ? 'sendMessagesInThreads' : 'sendMessages')
}

// The model is not trusted to get Discord's constraints right, so every field is checked here.
// keepChannel: the channel of a message being edited, which a message cannot leave.
function toChannelPost (draft, guild, member, { keepChannel = null } = {}) {
  if (!draft.found) return { error: draft.reason || '書き込む内容を決められませんでした。' }
  if (!canPostAsBot(member, guild)) return { error: NO_POST_PERMISSION }
  const channelID = keepChannel || String(draft.channel_id || '').replace(/[<#>]/g, '').trim()
  const channel = channelID && guild.channels.get(channelID)
  if (!channel || !POSTABLE_TYPES.includes(channel.type)) return { error: '書き込み先のテキストチャンネルが見つかりませんでした。' }
  const memberId = typeof member === 'string' ? member : (member?.id || member?.user?.id)
  if (!isCreator(memberId) && !canWrite(channel, member)) return { error: `依頼者が <#${channel.id}> に書き込む権限を持っていません。` }
  if (!canWrite(channel, global.bot.user.id)) return { error: `BOTが <#${channel.id}> に書き込む権限を持っていません。` }

  const content = withoutCharCount(String(draft.content || '').trim())
  if (!content) return { error: '書き込む本文を決められませんでした。' }
  const imageUrls = imageUrlsOf(draft)
  const botCanAttach = Boolean(safePermissionsOf(channel, global.bot.user.id)?.has('attachFiles'))

  return {
    message: {
      channelID: channel.id,
      content: content.slice(0, MAX_CONTENT),
      // The text comes from the model; never let it ping @everyone, roles or members.
      allowed_mentions: { parse: [] }
    },
    imageUrls: botCanAttach ? imageUrls : [],
    imageInstruction: botCanAttach ? imageInstructionOf(draft) : null,
    truncated: content.length > MAX_CONTENT
  }
}

module.exports = { SUBMIT_CHANNEL_POST_DECLARATION, NO_POST_PERMISSION, MODERATOR_PERMISSIONS, POSTABLE_TYPES, canPostAsBot, canWrite, toChannelPost }
