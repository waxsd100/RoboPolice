// Describes each server's custom emojis so the model can use them where they fit: Gemini looks at
// an emoji's image and name and says what it shows and when it is used, and that text is embedded
// so the emojis closest to a conversation can be offered first (describeServer in eventTools.js).
//
// Runs in the background on each worker for the servers it hosts: at startup and when a server's
// emojis change. Only new or renamed emojis are described; changing GEMINI_EMBEDDING_MODEL embeds
// them again. EMOJI_DESCRIPTIONS=false turns it off.
const store = require('../../db/interfaces/postgres/emojis')
const urlFetcher = require('../utils/urlFetcher')
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')
const { embed, model } = require('../utils/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')

const PER_RUN = 50
const MAX_DESCRIPTION = 80
// Changing how emojis are described describes them all again: it is part of the hash stored with
// each description.
const DESCRIBE_VERSION = 2

function enabled () {
  return isGatewayConfigured() && process.env.EMOJI_DESCRIPTIONS !== 'false'
}

// The emojis the bot can post: available ones not limited to certain roles.
function usableEmojis (guild) {
  return (guild.emojis || []).filter(e => e.id && e.name && e.available !== false && !(e.roles || []).length)
}

const imageURL = e => `https://cdn.discordapp.com/emojis/${e.emoji_id || e.id}.png?size=96`

// One short line: what the emoji shows and when it is used. characters: who the community's
// characters are (from its wiki), so an emoji of one is named.
async function describeEmoji (emoji, characters = '') {
  const { buffer, contentType } = await urlFetcher.fetchImage(imageURL(emoji))
  const known = characters
    ? `\n\nこのコミュニティの配信者のキャラクター（コミュニティの wiki より）:\n${characters}\n\n絵文字がこの中のキャラクターなら、説明にその名前を入れてください。どれにも当てはまらなければ名前は書かないでください。`
    : ''
  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{
      role: 'user',
      parts: [
        { text: `Discord のカスタム絵文字「:${emoji.name}:」の画像です。何が描かれているか、どんな気持ちや場面で使う絵文字かを、日本語の短い1文で書いてください。前置きや文字数は書かないでください。${known}` },
        { inlineData: { mimeType: contentType || 'image/png', data: buffer.toString('base64') } }
      ]
    }],
    generationConfig: { temperature: 0.2 }
  }, { timeoutMs: 30 * 1000 })
  const text = withoutCharCount(content.parts.map(p => p.text || '').join('').replace(/\s+/g, ' ').trim())
  if (!text) throw new Error('Gemini returned no description')
  return text.slice(0, MAX_DESCRIPTION)
}

const embedText = e => `:${e.name}: ${e.description}`

// Brings one server's stored emojis in step with Discord, then describes and embeds what is
// missing (up to PER_RUN each; the next run goes on). Resolves to { described, embedded }.
async function syncGuild (guild) {
  await store.syncEmojis(guild.id, usableEmojis(guild))
  // When what the wiki says about the characters changes, every emoji is described again.
  const characters = await require('./wikiKnowledge').characterContext()
  const hash = `v${DESCRIBE_VERSION}:${characters.hash || ''}`
  let described = 0
  for (const emoji of await store.emojisToDescribe(guild.id, PER_RUN, hash)) {
    try {
      await store.saveDescription(emoji.emoji_id, emoji.name, await describeEmoji(emoji, characters.text), hash)
      described++
    } catch (e) {
      global.logger.warn(`[EMOJIS]: Could not describe :${emoji.name}: in ${guild.id}: ${e.message}`)
    }
  }
  const current = model()
  const pending = await store.emojisToEmbed(guild.id, current, PER_RUN)
  if (pending.length) {
    const vectors = await embed(pending.map(embedText))
    for (const [i, e] of pending.entries()) await store.saveEmbedding(e.emoji_id, vectors[i], current)
  }
  if (described || pending.length) global.logger.info(`[EMOJIS]: ${guild.id}: described ${described}, embedded ${pending.length} emoji(s)`)
  return { described, embedded: pending.length }
}

// Servers waiting to be synced, worked through one at a time.
const queue = new Map()
let running = false
async function drain () {
  if (running) return
  running = true
  try {
    while (queue.size) {
      const [id, guild] = queue.entries().next().value
      queue.delete(id)
      await syncGuild(guild).catch(e => global.logger.warn(`[EMOJIS]: Could not sync ${id}: ${e.message}`))
    }
  } finally {
    running = false
  }
}

function schedule (guild) {
  if (!enabled() || !guild) return
  queue.set(guild.id, guild)
  drain()
}

function startDescriber () {
  if (!enabled()) return
  for (const guild of global.bot.guilds.values()) schedule(guild)
}

module.exports = { startDescriber, schedule, syncGuild, describeEmoji, usableEmojis, enabled, embedText }
