// The streamer's own Discord messages as knowledge, next to the wiki and the X posts
// (wikiKnowledge.js). Only in the owner's servers (priority.js), only in text and announcement
// channels everyone (@everyone) can read, and only the messages of DISCORD_KNOWLEDGE_USERS
// (comma-separated user IDs, e.g. the streamer's own account). Each channel's history is read back to its start once, 100 messages
// a request, one request every DISCORD_HISTORY_DELAY_MS; where it got to is kept, so a restart goes
// on from there. After that, new, edited and deleted messages are followed as they happen.
//
// Messages are stored in discord_posts. Each account's messages of a month also become one page of
// the knowledge tables as source 'discord' (one line per message with its date, channel and link),
// whose knowledge the worker owning shard 0 takes out and embeds with the wiki's (processPending), so they are searched with search_wiki.
const { knowledgeSetting } = require('../utils/knowledgeDefaults')
const { Constants } = require('eris')
const store = require('../../db/interfaces/postgres/discordPosts')
const knowledgeStore = require('../../db/interfaces/postgres/discordKnowledge')
const { ownerGuildIDs, isOwnerGuild } = require('../utils/priority')

const DEFAULT_DELAY_MS = 1000
const PAGE_SIZE = 100
const MAX_PART = 1500
const TEXT_CHANNELS = [0, 5]

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function users () {
  return String(knowledgeSetting('DISCORD_KNOWLEDGE_USERS')).split(',').map(s => s.trim()).filter(Boolean)
}

function enabled () {
  return users().length !== 0 && ownerGuildIDs().length !== 0
}

function delay () {
  const n = Number(process.env.DISCORD_HISTORY_DELAY_MS)
  return process.env.DISCORD_HISTORY_DELAY_MS && n >= 0 ? n : DEFAULT_DELAY_MS
}

// Whether @everyone can read the channel and its history: the @everyone role's permissions with
// the channel's (and its parent category's, if not overridden) overwrite for it.
const NEEDED = Constants.Permissions.viewChannel | Constants.Permissions.readMessageHistory
function everyoneCanRead (guild, channel) {
  let allow = BigInt(guild.roles?.get(guild.id)?.permissions?.allow ?? NEEDED)
  if (allow & Constants.Permissions.administrator) return true
  const parent = channel.parentID && guild.channels?.get(channel.parentID)
  const parentOverwrite = parent?.permissionOverwrites?.get(guild.id)
  if (parentOverwrite && !channel.permissionOverwrites?.has(guild.id)) {
    allow = (allow & ~BigInt(parentOverwrite.deny)) | BigInt(parentOverwrite.allow)
  }
  const overwrite = channel.permissionOverwrites?.get(guild.id)
  if (overwrite) allow = (allow & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow)
  return (allow & NEEDED) === NEEDED
}

function botCanRead (channel) {
  if (typeof channel?.permissionsOf !== 'function') return true
  const perms = channel.permissionsOf(global.bot.user.id)
  return perms.has('viewChannel') && perms.has('readMessageHistory')
}

// All text and announcement channels the bot can read (used for storing posts).
function botChannels (guild) {
  return [...guild.channels.values()].filter(c => TEXT_CHANNELS.includes(c.type) && botCanRead(c))
}

// The channels whose messages are referenced for learning: text and announcement channels everyone and the bot can read.
function publicChannels (guild) {
  return botChannels(guild).filter(c => everyoneCanRead(guild, c))
}

// Whether the message is one to store: by one of the accounts, in a channel the bot can see.
function counts (message) {
  const guild = message.channel?.guild
  return !!(guild && isOwnerGuild(guild.id) && users().includes(message.author?.id) &&
    TEXT_CHANNELS.includes(message.channel.type) && botCanRead(message.channel))
}

// guild and channel: where it was posted (a message read from a channel's history may not carry them).
function toPost (message, guild = message.channel.guild, channel = message.channel) {
  const content = String(message.content || '').trim()
  if (!content) return null
  return {
    id: message.id,
    guildID: guild.id,
    channelID: channel.id,
    channelName: channel.name || channel.id,
    authorID: message.author.id,
    content,
    createdAt: new Date(message.timestamp)
  }
}

function resolveAuthorName (guild, authorID) {
  const member = guild?.members?.get?.(authorID)
  const user = member?.user || global.bot?.users?.get?.(authorID)
  return member?.nick || user?.globalName || user?.username || null
}

const monthOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(date)
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)
const pageUrl = (guildID, authorID, month) => `https://discord.com/channels/${guildID}#${authorID}-${month}`
const messageLink = (guildID, p) => `https://discord.com/channels/${guildID}/${p.channel_id}/${p.id}`

// One month's messages as the parts of a page: one line per message, cut into parts of at most MAX_PART.
function monthSections (guildID, month, posts, authorName = null) {
  const [year, m] = month.split('-')
  const lines = posts.map(p => `[${dayOf(new Date(p.created_at))}] #${p.channel_name}: ${p.content.replace(/\s+/g, ' ')} ${messageLink(guildID, p)}`.slice(0, MAX_PART))
  const sections = []
  let current = []
  for (const line of lines) {
    if (current.length && [...current, line].join('\n').length > MAX_PART) {
      sections.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length) sections.push(current)
  const name = authorName || posts[posts.length - 1]?.author_name || '配信者'
  return {
    title: `${name} の Discord の発言（${year}年${Number(m)}月）`,
    sections: sections.map((s, i) => ({ heading: `${year}年${Number(m)}月 ${i + 1}`, text: s.join('\n'), images: [] }))
  }
}

// Writes the learning pages of the months given as `${guildID}/${authorID}/${month}`, referencing
// only channels @everyone can read; a month with no public messages left loses its page.
async function writeMonths (months, knownGuild = null) {
  for (const key of new Set(months)) {
    const [guildID, authorID, month] = key.split('/')
    const guild = (knownGuild?.id === guildID ? knownGuild : null) || global.bot?.guilds?.get(guildID)
    const allPosts = await store.postsOfMonth(guildID, authorID, month)
    const posts = allPosts.filter(p => {
      if (!guild) return false
      const ch = guild.channels?.get(p.channel_id)
      return !!(ch && everyoneCanRead(guild, ch))
    })
    const url = pageUrl(guildID, authorID, month)
    if (!posts.length) {
      await knowledgeStore.deletePagesExcept(url, [])
      continue
    }
    const page = monthSections(guildID, month, posts, resolveAuthorName(guild, authorID))
    await knowledgeStore.savePage(url, page.title, page.sections)
  }
}

const monthKey = p => `${p.guildID}/${p.authorID}/${monthOf(p.createdAt)}`

// Reads the channel's history back to its start, from where the last read stopped. Resolves to
// how many messages of the accounts were new.
async function readChannel (guild, channel, { wait = delay(), getMessages = (id, options) => global.bot.getMessages(id, options) } = {}) {
  const state = await store.backfillState(channel.id)
  if (state?.done) return 0
  let before = state?.before_id || undefined
  let added = 0
  const isPublic = everyoneCanRead(guild, channel)
  const months = new Set()
  for (;;) {
    // A message Eris could not read comes back as null: left out, but counted for a full page.
    const page = await getMessages(channel.id, { limit: PAGE_SIZE, ...(before ? { before } : {}) })
    const batch = page.filter(Boolean)
    const posts = batch.filter(m => users().includes(m.author?.id)).map(m => toPost(m, guild, channel)).filter(Boolean)
    const fresh = await store.savePosts(posts)
    if (isPublic) for (const p of fresh) months.add(monthKey(p))
    added += fresh.length
    const done = page.length < PAGE_SIZE
    if (batch.length) before = batch.reduce((oldest, m) => BigInt(m.id) < BigInt(oldest) ? m.id : oldest, batch[0].id)
    await store.saveBackfill(guild.id, channel.id, before || null, done)
    if (done) break
    await sleep(wait)
  }
  if (months.size) await writeMonths(months, guild)
  return added
}

// Reads the history of every bot-readable channel of the owner's servers this worker hosts, one
// channel at a time. All posts are stored in discord_posts; only @everyone-readable channels are
// written to the learning pages. One that fails is tried again at the next start.
let running = false
async function backfill (options) {
  if (running || !enabled()) return null
  running = true
  try {
    let added = 0
    for (const id of ownerGuildIDs()) {
      const guild = global.bot.guilds.get(id)
      if (!guild) continue
      for (const channel of botChannels(guild)) {
        try {
          added += await readChannel(guild, channel, options)
        } catch (e) {
          global.logger.warn(`[DISCORD]: Could not read the history of #${channel.name} in ${id}: ${e.message}`)
        }
      }
    }
    if (added) global.logger.info(`[DISCORD]: Stored ${added} past message(s) of ${users().join(', ')}`)
    return added
  } finally {
    running = false
  }
}

// A new or edited message of one of the accounts: stored in all bot-visible channels, and added to
// the learning pages only when @everyone can read the channel.
async function onMessage (message) {
  if (!enabled() || !counts(message)) return
  const post = toPost(message)
  if (!post) return
  const fresh = await store.savePosts([post])
  if (fresh.length && everyoneCanRead(message.channel.guild, message.channel)) {
    await writeMonths([monthKey(post)], message.channel.guild)
  }
}

// A deleted message: gone from the knowledge too.
async function onDelete (messageID) {
  if (Array.isArray(messageID)) return onDeleteMany(messageID)
  if (!enabled() || !messageID) return
  const gone = await store.deletePost(messageID)
  if (gone) await writeMonths(new Set([`${gone.guild_id}/${gone.author_id}/${monthOf(new Date(gone.created_at))}`]))
}

// Bulk deleted messages: deduplicates month keys so each affected month page is rebuilt once.
async function onDeleteMany (messageIDs) {
  if (!enabled() || !messageIDs?.length) return
  const uniqueIDs = [...new Set(messageIDs.filter(Boolean))]
  if (!uniqueIDs.length) return
  const deleted = typeof store.deletePosts === 'function' && (store.deletePosts.mock || !store.deletePost?.mock)
    ? await store.deletePosts(uniqueIDs)
    : (await Promise.all(uniqueIDs.map(id => store.deletePost(id)))).filter(Boolean)
  if (!deleted.length) return
  const months = new Set(deleted.map(g => `${g.guild_id}/${g.author_id}/${monthOf(new Date(g.created_at))}`))
  await writeMonths(months)
}

function startDiscordKnowledge () {
  if (!enabled()) return
  if (!ownerGuildIDs().some(id => global.bot.guilds.has(id))) return
  global.logger.startup(`[DISCORD]: Reading the messages of ${users().join(', ')} in the channels of the owner's servers (learning from public channels only).`)
  backfill().catch(e => global.logger.warn(`[DISCORD]: Reading past messages failed: ${e.message}`))
}

module.exports = { startDiscordKnowledge, backfill, readChannel, writeMonths, onMessage, onDelete, onDeleteMany, everyoneCanRead, botChannels, publicChannels, monthSections, users, enabled }
