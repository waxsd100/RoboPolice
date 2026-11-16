// Messages written into a channel from a mention ("#お知らせ に〇〇って書き込んで"): the submit
// tool the model fills in, who may ask for one, and the checks that turn its answer into a Discord
// "create message" request.
//
// The bot speaks for the server here, so only moderators and above may ask (canPostAsBot); the
// requester and the bot must also both be able to write in the channel.

const { withoutCharCount } = require('../utils/textClean')
const prompts = require('../utils/prompts')
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

// The descriptions are in prompts/tools/submit_channel_message_draft.md.
const SUBMIT_CHANNEL_POST_DECLARATION = prompts.tool('submit_channel_message_draft', {
  view: { maxContent: MAX_CONTENT, maxImages: MAX_IMAGE_CANDIDATES },
  parameters: {
    type: 'OBJECT',
    properties: {
      found: { type: 'BOOLEAN' },
      reason: { type: 'STRING' },
      channel_id: { type: 'STRING' },
      content: { type: 'STRING' },
      image_urls: { type: 'ARRAY', items: { type: 'STRING' } },
      image_instruction: IMAGE_INSTRUCTION_PROPERTY
    },
    required: ['found']
  }
})

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
