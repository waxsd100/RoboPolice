// Describes each server's custom emojis so the model can use them where they fit: Gemini looks at
// an emoji's image and name and says what it shows and when it is used, and that text is embedded
// so the emojis closest to a conversation can be offered first (describeServer in eventTools.js).
// Each few are embedded as soon as they are described.
//
// Runs in the background on each worker for the servers it hosts: at startup, when a server's
// emojis change, and every 6 hours (for those that failed). Only new or renamed emojis are described; changing GEMINI_EMBEDDING_MODEL embeds
// them again. EMOJI_DESCRIPTIONS=false turns it off.
const store = require('../../db/interfaces/postgres/emojis')
const urlFetcher = require('../utils/urlFetcher')
const { callGemini, DEFAULT_GEMINI_MODEL } = require('./eventDrafter')
const { embed, model } = require('../utils/embeddings')
const { isGatewayConfigured } = require('../utils/aiGateway')
const { withoutCharCount } = require('../utils/textClean')
const backgroundQueue = require('../utils/backgroundQueue')
const { ownerFirst } = require('../utils/priority')

const PER_RUN = 10
const EMBED_BATCH = 50
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const MAX_DESCRIPTION = 80
// Changing how emojis are described describes them all again: it is part of the hash stored with
// each description.
const DESCRIBE_VERSION = 3

function enabled () {
  return isGatewayConfigured() && process.env.EMOJI_DESCRIPTIONS !== 'false'
}

// The emojis the bot can post: available ones not limited to certain roles.
function usableEmojis (guild) {
  return (guild.emojis || []).filter(e => e.id && e.name && e.available !== false && !(e.roles || []).length)
}

const imageURL = e => `https://cdn.discordapp.com/emojis/${e.emoji_id || e.id}.png?size=96`

// The characters whose name or other name is in the emoji's name (yotsuron_happy → よつろん).
function namedIn (emojiName, names = []) {
  const lower = String(emojiName).toLowerCase()
  return names.filter(c => [c.name, ...(c.aliases || [])].some(n => n && n.length >= 2 && lower.includes(String(n).toLowerCase()))).map(c => c.name)
}

// Pictures of the characters from the wiki, fetched once per run: [{ name, buffer, contentType }].
// One that cannot be fetched is left out.
async function referenceImages (images = []) {
  const fetched = await Promise.all(images.map(i => urlFetcher.fetchImage(i.url)
    .then(({ buffer, contentType }) => ({ name: i.name, buffer, contentType }))
    .catch(() => null)))
  return fetched.filter(Boolean)
}

const inline = (buffer, contentType) => ({ inlineData: { mimeType: contentType || 'image/png', data: buffer.toString('base64') } })

// One short line: what the emoji shows and when it is used. context: who the community's
// characters are (wikiKnowledge.characterContext, with `references`, the fetched pictures of
// them), so an emoji of one is named.
async function describeEmoji (emoji, context = {}) {
  const { text: characters = '', names = [], references = [] } = typeof context === 'string' ? { text: context } : context
  const { buffer, contentType } = await urlFetcher.fetchImage(imageURL(emoji))
  const named = namedIn(emoji.name, names)
  const known = characters
    ? [
        '', '', `このコミュニティの配信者のキャラクター（コミュニティの wiki より）:\n${characters}`,
        ...(references.length ? ['', '下にこのうち何人かの wiki の画像を、絵文字の画像の前に付けています。絵文字がそのキャラクターかどうか、形（頭の飾り・顔・輪郭など）で見比べてください。'] : []),
        ...(named.length ? ['', `絵文字の名前「${emoji.name}」には、キャラクター「${named.join('」「')}」の名前が入っています。`] : []),
        '', '絵文字がこの中のキャラクターなら、説明の最初にその名前を書き、色や形を並べるより wiki に書かれたそのキャラクターの特徴（何者か・目立つ部分）を踏まえて書いてください。wiki にない設定は付け足さないでください。どれにも当てはまらなければ名前は書かないでください。'
      ].join('\n')
    : ''
  const parts = [{ text: `Discord のカスタム絵文字「:${emoji.name}:」の画像（最後の画像）です。何が描かれているか、どんな気持ちや場面で使う絵文字かを、日本語の短い1文で書いてください。前置きや文字数は書かないでください。${known}` }]
  if (characters) {
    for (const r of references) parts.push({ text: `参考: wiki の「${r.name}」の画像` }, inline(r.buffer, r.contentType))
  }
  parts.push({ text: `説明する絵文字「:${emoji.name}:」の画像` }, inline(buffer, contentType))
  const content = await callGemini(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL, {
    contents: [{ role: 'user', parts }],
    // Fewer tokens per image: emojis and the pictures they are compared with are small.
    generationConfig: { temperature: 0.2, mediaResolution: 'MEDIA_RESOLUTION_LOW' }
  }, { timeoutMs: 30 * 1000 })
  const text = withoutCharCount(content.parts.map(p => p.text || '').join('').replace(/\s+/g, ' ').trim())
  if (!text) throw new Error('Gemini returned no description')
  return text.slice(0, MAX_DESCRIPTION)
}

const embedText = e => `:${e.name}: ${e.description}`

// Embeds the server's described emojis that have no embedding by the current model. A failure is
// logged and left for the next run. Resolves to how many were embedded.
async function embedPending (guildID) {
  const current = model()
  let embedded = 0
  try {
    for (;;) {
      const pending = await store.emojisToEmbed(guildID, current, EMBED_BATCH)
      if (pending.length === 0) break
      const vectors = await embed(pending.map(embedText))
      for (const [i, e] of pending.entries()) await store.saveEmbedding(e.emoji_id, vectors[i], current)
      embedded += pending.length
    }
  } catch (e) {
    global.logger.warn(`[EMOJIS]: Could not embed the emojis of ${guildID}: ${e.message}`)
  }
  return embedded
}

// Brings one server's stored emojis in step with Discord, then describes and embeds what is
// missing. Resolves to { described, embedded, failed }.
async function syncGuild (guild) {
  await store.syncEmojis(guild.id, usableEmojis(guild))
  // When what the wiki says about the characters changes, every emoji is described again.
  const characters = await require('./wikiKnowledge').characterContext()
  const hash = `v${DESCRIBE_VERSION}:${characters.hash || ''}`
  // The pictures are fetched only when some emoji is to be described.
  let references = null
  const context = async () => {
    if (!references) references = await referenceImages(characters.images)
    return { ...characters, references }
  }
  // Embedded first: those described before (in a run that stopped part way) are searchable at once.
  let embedded = await embedPending(guild.id)
  // PER_RUN at a time until none are left, each batch embedded as soon as it is described, so a
  // description is never long without its embedding. One that fails is left out for the rest of
  // this run, so it cannot hold the others up, and is tried again on the next (CHECK_EVERY_MS at the latest).
  let described = 0
  const failed = new Set()
  for (;;) {
    const batch = (await store.emojisToDescribe(guild.id, PER_RUN + failed.size, hash)).filter(e => !failed.has(e.emoji_id))
    if (batch.length === 0) break
    for (const emoji of batch) {
      try {
        const description = await backgroundQueue.run(guild.id, async () => describeEmoji(emoji, await context()))
        await store.saveDescription(emoji.emoji_id, emoji.name, description, hash)
        described++
      } catch (e) {
        failed.add(emoji.emoji_id)
        global.logger.warn(`[EMOJIS]: Could not describe :${emoji.name}: in ${guild.id}: ${e.message}`)
      }
    }
    embedded += await embedPending(guild.id)
  }
  if (described || embedded || failed.size) global.logger.info(`[EMOJIS]: ${guild.id}: described ${described}, embedded ${embedded} emoji(s)${failed.size ? `, ${failed.size} failed` : ''}`)
  return { described, embedded, failed: failed.size }
}

// Servers waiting to be synced, worked through one at a time.
const queue = new Map()
let running = false
async function drain () {
  if (running) return
  running = true
  try {
    while (queue.size) {
      // The owner's servers first.
      const [id, guild] = ownerFirst([...queue.entries()], ([id]) => id)[0]
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

function scheduleAll () {
  for (const guild of global.bot.guilds.values()) schedule(guild)
}

// At startup, then every CHECK_EVERY_MS: emojis that failed are tried again, and anything missed
// is picked up. A server with nothing to do costs a few small queries.
let timer = null
function startDescriber () {
  if (!enabled()) return
  scheduleAll()
  if (!timer) timer = setInterval(scheduleAll, CHECK_EVERY_MS)
}

module.exports = { startDescriber, schedule, syncGuild, describeEmoji, usableEmojis, enabled, embedText, namedIn }
