// The streamer's own Discord messages as knowledge, next to the wiki and the X posts
// (wikiKnowledge.js). Only in the owner's servers (priority.js), only in text and announcement
// channels everyone (@everyone) can read, and only the messages of DISCORD_KNOWLEDGE_USERS
// (comma-separated user IDs, e.g. the streamer's own account). Each channel's history is read back to its start once, 100 messages
// a request, one request every DISCORD_HISTORY_DELAY_MS; where it got to is kept, so a restart goes
// on from there. After that, new, edited and deleted messages are followed as they happen.
//
// Messages are stored in discord_posts. Each account's messages of a month also become one page of
// the Discord knowledge tables (discord_pages / discord_sections / discord_facts; one line per
// message with its date, channel and link), whose knowledge the worker owning shard 0 takes out and
// embeds with the wiki's (processPending), so they are searched with search_wiki.
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
// the channel's overwrite for it.
const NEEDED = Constants.Permissions.viewChannel | Constants.Permissions.readMessageHistory
function everyoneCanRead (guild, channel) {
  let allow = BigInt(guild.roles.get(guild.id)?.permissions?.allow ?? 0)
  if (allow & Constants.Permissions.administrator) return true
  const overwrite = channel.permissionOverwrites?.get(guild.id)
  if (overwrite) allow = (allow & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow)
  return (allow & NEEDED) === NEEDED
}

// The channels whose messages are read: text and announcement channels everyone and the bot can read.
function publicChannels (guild) {
  return [...guild.channels.values()].filter(c => TEXT_CHANNELS.includes(c.type) &&
    everyoneCanRead(guild, c) &&
    c.permissionsOf(global.bot.user.id).has('viewChannel') && c.permissionsOf(global.bot.user.id).has('readMessageHistory'))
}

// Whether the message is one to keep: by one of the accounts, in one of those channels.
function counts (message) {
  const guild = message.channel?.guild
  return !!(guild && isOwnerGuild(guild.id) && users().includes(message.author?.id) &&
    TEXT_CHANNELS.includes(message.channel.type) && everyoneCanRead(guild, message.channel))
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
    authorName: message.member?.nick || message.author.globalName || message.author.username || message.author.id,
    content,
    createdAt: new Date(message.timestamp)
  }
}

const monthOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(date)
const dayOf = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date)
const pageUrl = (guildID, authorID, month) => `https://discord.com/channels/${guildID}#${authorID}-${month}`
const messageLink = (guildID, p) => `https://discord.com/channels/${guildID}/${p.channel_id}/${p.id}`

// One month's messages as the parts of a page: one line per message, cut into parts of at most MAX_PART.
function monthSections (guildID, month, posts) {
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
  const name = posts[posts.length - 1]?.author_name || '配信者'
  return {
    title: `${name} の Discord の発言（${year}年${Number(m)}月）`,
    sections: sections.map((s, i) => ({ heading: `${year}年${Number(m)}月 ${i + 1}`, text: s.join('\n'), images: [] }))
  }
}

// Writes the pages of the months given as `${guildID}/${authorID}/${month}`; a month with no
// messages left loses its page.
async function writeMonths (months) {
  for (const key of months) {
    const [guildID, authorID, month] = key.split('/')
    const posts = await store.postsOfMonth(guildID, authorID, month)
    const url = pageUrl(guildID, authorID, month)
    if (!posts.length) {
      await knowledgeStore.deletePagesExcept(url, [])
      continue
    }
    const page = monthSections(guildID, month, posts)
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
  const months = new Set()
  for (;;) {
    const batch = await getMessages(channel.id, { limit: PAGE_SIZE, ...(before ? { before } : {}) })
    const posts = batch.filter(m => users().includes(m.author?.id)).map(m => toPost(m, guild, channel)).filter(Boolean)
    const fresh = await store.savePosts(posts)
    for (const p of fresh) months.add(monthKey(p))
    added += fresh.length
    const done = batch.length < PAGE_SIZE
    if (batch.length) before = batch.reduce((oldest, m) => BigInt(m.id) < BigInt(oldest) ? m.id : oldest, batch[0].id)
    await store.saveBackfill(guild.id, channel.id, before || null, done)
    if (done) break
    await sleep(wait)
  }
  await writeMonths(months)
  return added
}

// Reads the history of every public channel of the owner's servers this worker hosts, one channel
// at a time. One that fails is tried again at the next start.
let running = false
async function backfill (options) {
  if (running || !enabled()) return null
  running = true
  try {
    let added = 0
    for (const id of ownerGuildIDs()) {
      const guild = global.bot.guilds.get(id)
      if (!guild) continue
      for (const channel of publicChannels(guild)) {
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

// A new or edited message of one of the accounts.
async function onMessage (message) {
  if (!enabled() || !counts(message)) return
  const post = toPost(message)
  if (!post) return
  const fresh = await store.savePosts([post])
  if (fresh.length) await writeMonths([monthKey(post)])
}

// A deleted message: gone from the knowledge too.
async function onDelete (messageID) {
  if (!enabled()) return
  const gone = await store.deletePost(messageID)
  if (gone) await writeMonths([`${gone.guild_id}/${gone.author_id}/${monthOf(new Date(gone.created_at))}`])
}

function startDiscordKnowledge () {
  if (!enabled()) return
  if (!ownerGuildIDs().some(id => global.bot.guilds.has(id))) return
  global.logger.startup(`[DISCORD]: Reading the messages of ${users().join(', ')} in the public channels of the owner's servers as knowledge.`)
  backfill().catch(e => global.logger.warn(`[DISCORD]: Reading past messages failed: ${e.message}`))
}

module.exports = { startDiscordKnowledge, backfill, readChannel, onMessage, onDelete, everyoneCanRead, publicChannels, monthSections, users, enabled }
