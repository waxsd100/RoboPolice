// Forum posts drafted from a mention: the submit tool the model fills in, the forums it may pick
// from, and the checks that turn its answer into a Discord "start thread in forum" request.
//
// The pinned Eris predates forum channels: it caches them as plain guild channels without tags or
// flags. Permissions come from that cache; tags, flags and guidelines are fetched from the API.

const { withoutCharCount } = require('../utils/textClean')
const { isCreator } = require('../utils/creatorIds')
const prompts = require('../utils/prompts')

const FORUM_TYPES = [15, 16] // GUILD_FORUM, GUILD_MEDIA
const REQUIRE_TAG = 1 << 4
const MAX_TAGS = 5
const MAX_TITLE = 100
const MAX_CONTENT = 2000
const MAX_IMAGE_CANDIDATES = 4
const MAX_IMAGE_INSTRUCTION = 500

// Shared by the submit tools: what the requester said about the image itself.
const IMAGE_INSTRUCTION_PROPERTY = {
  type: 'STRING',
  description: prompts.render('tools/shared/image-instruction')
}

// The descriptions are in prompts/tools/submit_forum_post_draft.md.
const SUBMIT_FORUM_DECLARATION = prompts.tool('submit_forum_post_draft', {
  view: { maxTitle: MAX_TITLE, maxContent: MAX_CONTENT, maxTags: MAX_TAGS, maxImages: MAX_IMAGE_CANDIDATES },
  parameters: {
    type: 'OBJECT',
    properties: {
      found: { type: 'BOOLEAN' },
      reason: { type: 'STRING' },
      channel_id: { type: 'STRING' },
      title: { type: 'STRING' },
      content: { type: 'STRING' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      image_urls: { type: 'ARRAY', items: { type: 'STRING' } },
      image_instruction: IMAGE_INSTRUCTION_PROPERTY
    },
    required: ['found']
  }
})

// The image candidates the model picked, best first: plain http(s) URLs only, without duplicates.
// Fetching them later goes through the same address checks as any other URL. A single image_url
// is accepted too.
function imageUrlsOf (draft) {
  const urls = [...(Array.isArray(draft.image_urls) ? draft.image_urls : []), draft.image_url]
    .map(u => String(u || '').trim())
    .filter(u => /^https?:\/\/\S+$/i.test(u))
  return [...new Set(urls)].slice(0, MAX_IMAGE_CANDIDATES)
}

function imageInstructionOf (draft) {
  return String(draft.image_instruction || '').trim().slice(0, MAX_IMAGE_INSTRUCTION) || null
}

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

function canPost (channel, memberOrId) {
  const perms = safePermissionsOf(channel, memberOrId)
  return Boolean(perms && perms.has('viewChannel') && perms.has('sendMessages'))
}

function fetchForum (channelID) {
  return global.bot.requestHandler.request('GET', `/channels/${channelID}`, true)
}

// Tags the bot may apply: moderated tags need Manage Threads in that forum for both bot and requester.
function usableTags (channel, forum, member = null) {
  const botCanModerate = Boolean(safePermissionsOf(channel, global.bot.user.id)?.has('manageThreads'))
  const memberId = typeof member === 'string' ? member : (member?.id || member?.user?.id)
  const userCanModerate = !member || isCreator(memberId) || Boolean(safePermissionsOf(channel, member)?.has('manageThreads'))
  return (forum.available_tags || []).filter(t => !t.moderated || (botCanModerate && userCanModerate))
}

function postableForums (guild, member) {
  return [...guild.channels.values()]
    .filter(c => FORUM_TYPES.includes(c.type) && canPost(c, member) && canPost(c, global.bot.user.id))
}

async function describeForums (guild, member) {
  const forums = postableForums(guild, member)
  if (forums.length === 0) return '依頼者とBOTの両方が投稿できるフォーラムはありません'
  const described = await Promise.all(forums.map(async c => {
    const forum = await fetchForum(c.id)
    const tags = usableTags(c, forum, member).map(t => t.name)
    const lines = [`- ${c.id}: ${c.name}`]
    if (tags.length !== 0) lines.push(`  タグ: ${tags.join(', ')}${forum.flags & REQUIRE_TAG ? '（1つ以上必須）' : ''}`)
    if (forum.topic) lines.push(`  投稿ガイドライン: ${forum.topic.slice(0, 500)}`)
    return lines.join('\n')
  }))
  return described.join('\n')
}

// The model is not trusted to get Discord's constraints right, so every field is checked here.
async function toForumPost (draft, guild, member) {
  if (!draft.found) return { error: draft.reason || '投稿の内容を決められませんでした。' }
  const channel = draft.channel_id && guild.channels.get(draft.channel_id)
  if (!channel || !FORUM_TYPES.includes(channel.type)) return { error: '投稿先のフォーラムが見つかりませんでした。' }
  const memberId = typeof member === 'string' ? member : (member?.id || member?.user?.id)
  if (!isCreator(memberId) && !canPost(channel, member)) return { error: `依頼者が <#${channel.id}> に投稿する権限を持っていません。` }
  if (!canPost(channel, global.bot.user.id)) return { error: `BOTが <#${channel.id}> に投稿する権限を持っていません。` }

  const title = (draft.title || '').trim().slice(0, MAX_TITLE)
  if (!title) return { error: '投稿の題名を決められませんでした。' }
  const content = (draft.content || '').trim()
  if (!content) return { error: '投稿の本文を決められませんでした。' }

  const forum = await fetchForum(channel.id)
  const byName = new Map(usableTags(channel, forum, member).map(t => [t.name.toLowerCase(), t]))
  const tags = [...new Set((draft.tags || []).map(n => byName.get(String(n).trim().toLowerCase())).filter(Boolean))].slice(0, MAX_TAGS)
  if ((forum.flags & REQUIRE_TAG) && tags.length === 0) {
    return { error: `<#${channel.id}> はタグが必須ですが、付けられるタグを決められませんでした。` }
  }

  return {
    post: {
      channelID: channel.id,
      name: title,
      message: {
        content: withoutCharCount(content).slice(0, MAX_CONTENT),
        // The text comes from the model; never let it ping @everyone, roles or members.
        allowed_mentions: { parse: [] }
      },
      applied_tags: tags.map(t => t.id)
    },
    tagNames: tags.map(t => t.name),
    imageUrls: imageUrlsOf(draft),
    imageInstruction: imageInstructionOf(draft),
    truncated: content.length > MAX_CONTENT
  }
}

module.exports = { SUBMIT_FORUM_DECLARATION, IMAGE_INSTRUCTION_PROPERTY, toForumPost, describeForums, postableForums, canPost, usableTags, safePermissionsOf, imageUrlsOf, imageInstructionOf, MAX_IMAGE_CANDIDATES, FORUM_TYPES, REQUIRE_TAG }
