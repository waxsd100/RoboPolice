// Custom emojis in a request (or the conversation it replies to) that the model cannot read from
// their code, given to it as images with the request. Only for that request: nothing is stored.
//
// - Other servers' emojis: one image each.
// - Combined emojis (連結絵文字): emojis written side by side, on one line or as rows of several
//   lines, that together make one picture. Their tiles are stitched into that picture, whether
//   they are this server's emojis or another's; a tile alone means little.
const sharp = require('sharp')
const urlFetcher = require('./urlFetcher')

const MAX_EMOJIS = 6
const MAX_GROUPS = 3
const MAX_SIDE = 8
const TILE = 64
const EMOJI = /<(a?):(\w{2,32}):(\d{15,25})>/g
const RUN = /(?:<a?:\w{2,32}:\d{15,25}>){2,}/g

const parse = text => [...String(text).matchAll(EMOJI)].map(([, animated, name, id]) => ({ id, name, animated: !!animated }))
const imageURL = id => `https://cdn.discordapp.com/emojis/${id}.png?size=96`

// The combined emojis in `texts`: [{ rows: [[{ id, name, animated }]] }]. Lines that are nothing but
// a run of emojis, one after another, make one picture of several rows; a run inside a line is a
// picture of one row.
function emojiGroups (texts) {
  const groups = []
  for (const text of texts) {
    let rows = []
    const close = () => {
      if (rows.length) groups.push({ rows })
      rows = []
    }
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim()
      const runs = trimmed.match(RUN) || []
      if (runs.length === 1 && runs[0] === trimmed) {
        rows.push(parse(trimmed))
        continue
      }
      close()
      for (const run of runs) groups.push({ rows: [parse(run)] })
    }
    close()
  }
  return groups
    .filter(g => g.rows.length <= MAX_SIDE && g.rows.every(r => r.length <= MAX_SIDE))
    .slice(0, MAX_GROUPS)
}

// The emojis in `texts` that are not the server's own (which have descriptions already) and not
// part of a combined emoji, each once: [{ id, name, animated }].
function foreignEmojis (texts, guild, groups = emojiGroups(texts)) {
  const own = new Set((guild?.emojis || []).map(e => e.id))
  const inGroups = new Set(groups.flatMap(g => g.rows.flat().map(e => e.id)))
  const seen = new Map()
  for (const text of texts) {
    for (const e of parse(text || '')) {
      if (!own.has(e.id) && !inGroups.has(e.id) && !seen.has(e.id)) seen.set(e.id, e)
    }
  }
  return [...seen.values()].slice(0, MAX_EMOJIS)
}

// Their images, for the model: [{ name, buffer, mimeType }]. One that cannot be fetched is left out.
async function emojiPictures (emojis) {
  const fetched = await Promise.all(emojis.map(e => urlFetcher.fetchImage(imageURL(e.id))
    .then(({ buffer, contentType }) => ({ name: e.name, buffer, mimeType: contentType || 'image/png' }))
    .catch(() => null)))
  return fetched.filter(Boolean)
}

// One combined emoji stitched into its picture: { name, buffer, mimeType, combined: true }, its name
// the codes it is written with, row by row. A tile that cannot be fetched is left blank.
async function stitch (group, fetchTile) {
  const width = Math.max(...group.rows.map(r => r.length))
  const tiles = []
  for (const [y, row] of group.rows.entries()) {
    for (const [x, e] of row.entries()) {
      const input = await fetchTile(e.id)
      if (input) tiles.push({ input, left: x * TILE, top: y * TILE })
    }
  }
  if (!tiles.length) return null
  const buffer = await sharp({ create: { width: width * TILE, height: group.rows.length * TILE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(tiles).png().toBuffer()
  const name = group.rows.map(r => r.map(e => `:${e.name}:`).join('')).join(' / ')
  return { name, buffer, mimeType: 'image/png', combined: true }
}

// The combined emojis' pictures. Each tile is fetched once.
async function combinedPictures (groups) {
  const cache = new Map()
  const fetchTile = id => {
    if (!cache.has(id)) {
      cache.set(id, urlFetcher.fetchImage(imageURL(id))
        .then(({ buffer }) => sharp(buffer, { animated: false }).resize(TILE, TILE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
        .catch(() => null))
    }
    return cache.get(id)
  }
  const pictures = []
  for (const group of groups) {
    const picture = await stitch(group, fetchTile).catch(() => null)
    if (picture) pictures.push(picture)
  }
  return pictures
}

// Everything to show the model for `texts`: combined emojis first, then other servers' emojis.
async function picturesFor (texts, guild) {
  const groups = emojiGroups(texts)
  const [combined, foreign] = await Promise.all([combinedPictures(groups), emojiPictures(foreignEmojis(texts, guild, groups))])
  return [...combined, ...foreign]
}

module.exports = { foreignEmojis, emojiPictures, emojiGroups, combinedPictures, picturesFor, MAX_EMOJIS }
