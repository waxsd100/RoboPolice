// Forum posts drafted from a mention: the submit tool the model fills in, the forums it may pick
// from, and the checks that turn its answer into a Discord "start thread in forum" request.
//
// The pinned Eris predates forum channels: it caches them as plain guild channels without tags or
// flags. Permissions come from that cache; tags, flags and guidelines are fetched from the API.

const FORUM_TYPES = [15, 16] // GUILD_FORUM, GUILD_MEDIA
const REQUIRE_TAG = 1 << 4
const MAX_TAGS = 5
const MAX_TITLE = 100
const MAX_CONTENT = 2000
const MAX_IMAGE_CANDIDATES = 4

const SUBMIT_FORUM_DECLARATION = {
  name: 'submit_forum_post_draft',
  description: 'フォーラムへの投稿を頼まれたとき、調べ終わったら必ず最後に1回だけ呼ぶ。投稿の下書き、または作れない理由を提出する。',
  parameters: {
    type: 'OBJECT',
    properties: {
      found: { type: 'BOOLEAN', description: '投稿先と、投稿の題名・本文を決められたか' },
      reason: { type: 'STRING', description: 'found が false のとき、何が足りないかを利用者向けに日本語で一文' },
      channel_id: { type: 'STRING', description: '投稿先のフォーラムの ID（list_forums で確認したもの）' },
      title: { type: 'STRING', description: `投稿の題名（${MAX_TITLE}文字以内）` },
      content: { type: 'STRING', description: `投稿の本文（${MAX_CONTENT}文字以内、Discord の Markdown 可）。参照元のリンクがあれば末尾に含める` },
      tags: { type: 'ARRAY', items: { type: 'STRING' }, description: `付けるタグの名前（list_forums に出たものから最大${MAX_TAGS}個）` },
      image_urls: { type: 'ARRAY', items: { type: 'STRING' }, description: `投稿に添える画像の候補 URL（良い順、最大${MAX_IMAGE_CANDIDATES}つ）。参照したページの og:image / twitter:image、メッセージの添付画像・埋め込み画像から内容に合うものを選ぶ。ロゴやアイコンなど小さい画像は選ばない。なければ空` }
    },
    required: ['found']
  }
}

// The image candidates the model picked, best first: plain http(s) URLs only, without duplicates.
// Fetching them later goes through the same address checks as any other URL. A single image_url
// is accepted too.
function imageUrlsOf (draft) {
  const urls = [...(Array.isArray(draft.image_urls) ? draft.image_urls : []), draft.image_url]
    .map(u => String(u || '').trim())
    .filter(u => /^https?:\/\/\S+$/i.test(u))
  return [...new Set(urls)].slice(0, MAX_IMAGE_CANDIDATES)
}

function canPost (channel, userID) {
  const perms = channel.permissionsOf(userID)
  return perms.has('viewChannel') && perms.has('sendMessages')
}

function fetchForum (channelID) {
  return global.bot.requestHandler.request('GET', `/channels/${channelID}`, true)
}

// Tags the bot may apply: moderated tags need Manage Threads in that forum.
function usableTags (channel, forum) {
  const botCanModerate = channel.permissionsOf(global.bot.user.id).has('manageThreads')
  return (forum.available_tags || []).filter(t => !t.moderated || botCanModerate)
}

function postableForums (guild, member) {
  return [...guild.channels.values()]
    .filter(c => FORUM_TYPES.includes(c.type) && canPost(c, member.id) && canPost(c, global.bot.user.id))
}

async function describeForums (guild, member) {
  const forums = postableForums(guild, member)
  if (forums.length === 0) return '依頼者とBOTの両方が投稿できるフォーラムはありません'
  const described = await Promise.all(forums.map(async c => {
    const forum = await fetchForum(c.id)
    const tags = usableTags(c, forum).map(t => t.name)
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
  if (!canPost(channel, member.id)) return { error: `依頼者が <#${channel.id}> に投稿する権限を持っていません。` }
  if (!canPost(channel, global.bot.user.id)) return { error: `BOTが <#${channel.id}> に投稿する権限を持っていません。` }

  const title = (draft.title || '').trim().slice(0, MAX_TITLE)
  if (!title) return { error: '投稿の題名を決められませんでした。' }
  const content = (draft.content || '').trim()
  if (!content) return { error: '投稿の本文を決められませんでした。' }

  const forum = await fetchForum(channel.id)
  const byName = new Map(usableTags(channel, forum).map(t => [t.name.toLowerCase(), t]))
  const tags = [...new Set((draft.tags || []).map(n => byName.get(String(n).trim().toLowerCase())).filter(Boolean))].slice(0, MAX_TAGS)
  if ((forum.flags & REQUIRE_TAG) && tags.length === 0) {
    return { error: `<#${channel.id}> はタグが必須ですが、付けられるタグを決められませんでした。` }
  }

  return {
    post: {
      channelID: channel.id,
      name: title,
      message: {
        content: content.slice(0, MAX_CONTENT),
        // The text comes from the model; never let it ping @everyone, roles or members.
        allowed_mentions: { parse: [] }
      },
      applied_tags: tags.map(t => t.id)
    },
    tagNames: tags.map(t => t.name),
    imageUrls: imageUrlsOf(draft),
    truncated: content.length > MAX_CONTENT
  }
}

module.exports = { SUBMIT_FORUM_DECLARATION, toForumPost, describeForums, postableForums, imageUrlsOf, MAX_IMAGE_CANDIDATES, FORUM_TYPES, REQUIRE_TAG }
