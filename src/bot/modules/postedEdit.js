// Changing something the bot made earlier from a mention: a scheduled event it registered, a
// forum post it started, or a message it wrote into a channel. The mention says which by replying
// to the bot's "登録しました / 投稿しました / 書き込みました" message, or (for a forum post or a
// message) to the post itself. Only what the bot made can be changed this
// way, and with the same permissions it took to make it.
const urlFetcher = require('../utils/urlFetcher')
const { ENTITY_TYPES } = require('./eventDrafter')
const { FORUM_TYPES, canPost } = require('./forumPost')
const { POSTABLE_TYPES, canWrite } = require('./channelPost')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const mentionLogsStore = require('../../db/interfaces/postgres/mentionLogs')

const EVENT_LINK = /https:\/\/discord\.com\/events\/(\d+)\/(\d+)/
const MESSAGE_LINK = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/
const POST_LINK = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)(?![\d/])/
const ACTIVE_EVENT_STATUSES = [1, 2] // SCHEDULED, ACTIVE; finished or cancelled ones can't change
const LOCATION_TYPES = { [ENTITY_TYPES.stage]: 'stage', [ENTITY_TYPES.voice]: 'voice', [ENTITY_TYPES.external]: 'external' }

// Added to the message saying something was made or changed, which is what to reply to.
const EDIT_HINT = '-# 後から直すときは、このメッセージに返信する形でメンションして、直したいことを書いてください。'

class EditRefused extends Error {}

function safePermissionsOf (channel, memberOrId) {
  if (!channel || typeof channel.permissionsOf !== 'function' || !memberOrId) return null
  const id = typeof memberOrId === 'string' ? memberOrId : (memberOrId.id || memberOrId.user?.id)
  if (id) {
    try {
      const perms = channel.permissionsOf(id)
      if (perms) return perms
    } catch (_) {}
  }
  if (typeof memberOrId === 'object') {
    try { return channel.permissionsOf(memberOrId) || null } catch (_) {}
  }
  return null
}

function request (method, url, body, files) {
  return global.bot.requestHandler.request(method, url, true, body, files)
}

// { kind, id } of what the replied-to message points at, or null when it is not something the
// bot made.
async function findTarget (guild, channelID, messageID) {
  const replied = await global.bot.getMessage(channelID, messageID).catch(() => null)
  if (!replied || replied.author?.id !== global.bot.user.id) return null
  // A forum post's first message has the thread's ID; load() checks it really is a forum post.
  if (messageID === channelID) return { kind: 'forum', id: channelID }
  // A message the bot wrote into a channel from a mention, replied to directly: the mention logs
  // tell it from the bot's other messages (chat replies, logs).
  if (await postedBy(guild.id, `${channelID}/${messageID}`, 'message')) return { kind: 'message', channelID, id: messageID }
  const event = replied.content.match(EVENT_LINK)
  if (event && event[1] === guild.id) return { kind: 'event', id: event[2] }
  const written = replied.content.match(MESSAGE_LINK)
  if (written && written[1] === guild.id) return { kind: 'message', channelID: written[2], id: written[3] }
  const post = replied.content.match(POST_LINK)
  if (post && post[1] === guild.id) return { kind: 'forum', id: post[2] }
  return null
}

// Who asked for what the bot made at `path` ("threadID" or "channelID/messageID"), from the
// mention logs; null when unknown.
function postedBy (guildID, path, kind) {
  if (typeof mentionLogsStore.findPostCreator !== 'function') return Promise.resolve(null)
  return mentionLogsStore.findPostCreator(guildID, path, kind).catch(() => null)
}

// Downloads an existing image for the preview. The image stays even if this fails.
async function currentImage (url) {
  if (!url) return null
  try {
    return { buffer: (await urlFetcher.fetchImage(url)).buffer }
  } catch (_) {
    return { buffer: null }
  }
}

// The target's present content, as the submit tool's arguments, plus what is needed to update it.
async function load (guild, target, member = null) {
  if (target.kind === 'event') {
    const event = await request('GET', `/guilds/${guild.id}/scheduled-events/${target.id}`).catch(() => null)
    if (!event || event.creator_id !== global.bot.user.id) throw new EditRefused('BOT が登録したイベントではないため、直せません。')
    if (!ACTIVE_EVENT_STATUSES.includes(event.status)) throw new EditRefused('終了または中止したイベントは直せません。')
    return {
      ...target,
      link: `https://discord.com/events/${guild.id}/${event.id}`,
      current: {
        found: true,
        name: event.name,
        description: event.description || '',
        start: event.scheduled_start_time,
        end: event.scheduled_end_time || '',
        location_type: LOCATION_TYPES[event.entity_type] || 'external',
        location: event.entity_metadata?.location || '',
        channel_id: event.channel_id || ''
      },
      image: await currentImage(event.image && `https://cdn.discordapp.com/guild-events/${event.id}/${event.image}.png?size=1024`)
    }
  }

  if (target.kind === 'message') return loadMessage(guild, target, member)

  const thread = await request('GET', `/channels/${target.id}`).catch(() => null)
  const starter = thread && await global.bot.getMessage(target.id, target.id).catch(() => null)
  if (!starter || starter.author?.id !== global.bot.user.id || thread.guild_id !== guild.id) {
    throw new EditRefused('BOT が投稿したフォーラムの投稿ではないため、直せません。')
  }
  const forum = await request('GET', `/channels/${thread.parent_id}`)
  if (!FORUM_TYPES.includes(forum.type)) throw new EditRefused('フォーラムの投稿ではないため、直せません。')
  const forumChannel = guild.channels?.get?.(thread.parent_id) || global.bot?.getChannel?.(thread.parent_id) || null
  if (member) {
    if (!isCreator(member.id) && !(forumChannel && canPost(forumChannel, member))) {
      throw new EditRefused('このフォーラムに投稿する権限がないため編集できません')
    }
    if (thread.thread_metadata?.locked && !isCreator(member.id) && !safePermissionsOf(forumChannel, member)?.has('manageThreads')) {
      throw new EditRefused('ロックされたスレッドは編集できません')
    }
    const creatorID = await postedBy(guild.id, thread.id, 'forum')
    if (creatorID && creatorID !== member.id && !isCreator(member.id) && !hasStaffAccess(member.roles, guild) && !safePermissionsOf(forumChannel, member)?.has('manageThreads')) {
      throw new EditRefused('他のメンバーが作成したフォーラム投稿は編集できません')
    }
  }
  const tagNames = new Map((forum.available_tags || []).map(t => [t.id, t.name]))
  const attached = (starter.attachments || []).find(a => /^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp|gif)$/i.test(a.filename || ''))
  return {
    ...target,
    link: `https://discord.com/channels/${guild.id}/${thread.id}`,
    current: {
      found: true,
      channel_id: thread.parent_id,
      title: thread.name,
      content: starter.content,
      tags: (thread.applied_tags || []).map(id => tagNames.get(id)).filter(Boolean)
    },
    image: await currentImage(attached?.url)
  }
}

// A message the bot wrote into a channel. Only moderators may ask (checked in mentionEvent.js);
// they must still be able to write in that channel.
async function loadMessage (guild, target, member) {
  const channel = guild.channels?.get?.(target.channelID)
  const written = channel && POSTABLE_TYPES.includes(channel.type) && await global.bot.getMessage(target.channelID, target.id).catch(() => null)
  if (!written || written.author?.id !== global.bot.user.id || written.webhookID) {
    throw new EditRefused('BOT が書き込んだメッセージではないため、直せません。')
  }
  if (member && !isCreator(member.id) && !canWrite(channel, member)) {
    throw new EditRefused('このチャンネルに書き込む権限がないため編集できません')
  }
  const attached = (written.attachments || []).find(a => /^image\//.test(a.content_type || '') || /\.(jpe?g|png|webp|gif)$/i.test(a.filename || ''))
  return {
    ...target,
    link: `https://discord.com/channels/${guild.id}/${target.channelID}/${target.id}`,
    current: { found: true, channel_id: target.channelID, content: written.content },
    image: await currentImage(attached?.url)
  }
}

// The image part of an update: unchanged ('keep'), removed ('none'), or the new rendering.
function imageChange (cover) {
  if (cover.mode === 'keep' || (cover.mode === 'none' && !cover.current)) return { keep: true }
  return { buffer: cover.buffer }
}

async function updateEvent (guild, target, { event }, cover, author) {
  if (!guild.members.get(global.bot.user.id)?.permissions.has('manageEvents')) {
    return 'BOTに「イベントの管理」権限がないため、イベントを直せませんでした。'
  }
  const external = event.entity_type === ENTITY_TYPES.external
  const image = imageChange(cover)
  await request('PATCH', `/guilds/${guild.id}/scheduled-events/${target.id}`, {
    name: event.name,
    description: event.description || '',
    // A running event refuses a new start time, even the same one.
    ...(event.scheduled_start_time !== new Date(target.current.start).toISOString() ? { scheduled_start_time: event.scheduled_start_time } : {}),
    scheduled_end_time: event.scheduled_end_time,
    entity_type: event.entity_type,
    channel_id: external ? null : event.channel_id,
    entity_metadata: external ? event.entity_metadata : null,
    ...(image.keep ? {} : { image: image.buffer ? `data:image/jpeg;base64,${image.buffer.toString('base64')}` : null }),
    reason: `Requested by ${author.username} (${author.id})`
  })
  return `イベントを更新しました: ${target.link}\n${EDIT_HINT}`
}

async function updateForumPost (guild, target, { post }, cover, author) {
  const reason = `Requested by ${author.username} (${author.id})`
  await request('PATCH', `/channels/${target.id}`, { name: post.name, applied_tags: post.applied_tags, reason })
  const image = imageChange(cover)
  const files = image.buffer ? [{ name: 'files[0]', file: image.buffer }] : undefined
  await request('PATCH', `/channels/${target.id}/messages/${target.id}`, {
    ...post.message,
    // Listing attachments replaces the old ones; leaving the list out keeps them.
    ...(image.keep ? {} : { attachments: image.buffer ? [{ id: 0, filename: 'image.jpg' }] : [] })
  }, files)
  return `フォーラムの投稿を更新しました: ${target.link}\n${EDIT_HINT}`
}

async function updateMessage (guild, target, { message }, cover) {
  const { channelID, ...body } = message
  const image = imageChange(cover)
  const files = image.buffer ? [{ name: 'files[0]', file: image.buffer }] : undefined
  await request('PATCH', `/channels/${target.channelID}/messages/${target.id}`, {
    ...body,
    // Listing attachments replaces the old ones; leaving the list out keeps them.
    ...(image.keep ? {} : { attachments: image.buffer ? [{ id: 0, filename: 'image.jpg' }] : [] })
  }, files)
  return `書き込みを更新しました: ${target.link}\n${EDIT_HINT}`
}

function update (guild, target, result, cover, author) {
  if (target.kind === 'event') return updateEvent(guild, target, result, cover, author)
  if (target.kind === 'message') return updateMessage(guild, target, result, cover)
  return updateForumPost(guild, target, result, cover, author)
}

// What the draft changes, by name, so the requester can see nothing else is touched.
function changes (target, result) {
  if (!target || !result || (result.kind && result.kind !== target.kind)) return []
  const was = target.current
  if (target.kind === 'event') {
    const { event } = result
    if (!event) return []
    const location = event.entity_type === ENTITY_TYPES.external ? `external:${event.entity_metadata.location}` : `${LOCATION_TYPES[event.entity_type]}:${event.channel_id}`
    const wasLocation = was.location_type === 'external' ? `external:${was.location}` : `${was.location_type}:${was.channel_id}`
    const nextStart = event.scheduled_start_time ? new Date(event.scheduled_start_time).toISOString() : ''
    const prevStart = was.start ? new Date(was.start).toISOString() : ''
    const nextEnd = event.scheduled_end_time ? new Date(event.scheduled_end_time).toISOString() : ''
    const prevEnd = was.end ? new Date(was.end).toISOString() : ''
    return [
      event.name !== was.name && 'イベント名',
      (event.description || '') !== was.description && '説明',
      nextStart !== prevStart && '開始',
      nextEnd !== prevEnd && '終了',
      location !== wasLocation && '場所'
    ].filter(Boolean)
  }
  if (target.kind === 'message') {
    if (!result.message) return []
    return [result.message.content !== was.content && '本文'].filter(Boolean)
  }
  const { post, tagNames = [] } = result
  if (!post) return []
  return [
    post.name !== was.title && '題名',
    post.message.content !== was.content && '本文',
    [...tagNames].sort().join('\n') !== [...was.tags].sort().join('\n') && 'タグ'
  ].filter(Boolean)
}

module.exports = { findTarget, load, update, changes, EditRefused, EDIT_HINT }
