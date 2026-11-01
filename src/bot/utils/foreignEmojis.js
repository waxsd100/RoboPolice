// Custom emojis from other servers in a request (or the conversation it replies to): the model
// cannot tell what they show from their code, so their images are given to it with the request.
// Only for that request: nothing is stored.
const urlFetcher = require('./urlFetcher')

const MAX_EMOJIS = 6
const EMOJI = /<(a?):(\w{2,32}):(\d{15,25})>/g

// The emojis in `texts` that are not the server's own (which have descriptions already), each
// once: [{ id, name, animated }].
function foreignEmojis (texts, guild) {
  const own = new Set((guild?.emojis || []).map(e => e.id))
  const seen = new Map()
  for (const text of texts) {
    for (const [, animated, name, id] of String(text || '').matchAll(EMOJI)) {
      if (!own.has(id) && !seen.has(id)) seen.set(id, { id, name, animated: !!animated })
    }
  }
  return [...seen.values()].slice(0, MAX_EMOJIS)
}

// Their images, for the model: [{ name, buffer, mimeType }]. One that cannot be fetched is left out.
async function emojiPictures (emojis) {
  const fetched = await Promise.all(emojis.map(e => urlFetcher.fetchImage(`https://cdn.discordapp.com/emojis/${e.id}.png?size=96`)
    .then(({ buffer, contentType }) => ({ name: e.name, buffer, mimeType: contentType || 'image/png' }))
    .catch(() => null)))
  return fetched.filter(Boolean)
}

module.exports = { foreignEmojis, emojiPictures, MAX_EMOJIS }
