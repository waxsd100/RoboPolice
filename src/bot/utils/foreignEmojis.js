// Custom emojis in a request (or the conversation it replies to) that the model cannot read from
// their code, given to it as images with the request. Only for that request: nothing is stored.
//
// - Other servers' emojis: one image each.
// - Combined emojis (連結絵文字): emojis that, written side by side (on one line, or as rows of
//   several lines), make one picture. Their tiles are stitched into that picture, whether they are
//   this server's emojis or another's; a tile alone means little. Emojis merely written next to
//   each other are not one: a run counts only when its names are one name numbered (nobaman_1,
//   nobaman_2…), or when its tiles' pictures carry on across their edges (isOnePicture).
const sharp = require('sharp')
const urlFetcher = require('./urlFetcher')

const MAX_EMOJIS = 6
const MAX_GROUPS = 3
// Runs of emojis looked at to find them: most are emojis merely written next to each other.
const MAX_CANDIDATES = 8
const MAX_SIDE = 8
const TILE = 64
const EMOJI = /<(a?):(\w{2,32}):(\d{15,25})>/g
const RUN = /(?:<a?:\w{2,32}:\d{15,25}>){2,}/g

const parse = text => [...String(text).matchAll(EMOJI)].map(([, animated, name, id]) => ({ id, name, animated: !!animated }))
const imageURL = id => `https://cdn.discordapp.com/emojis/${id}.png?size=96`

// The runs of emojis in `texts` that may be combined emojis: [{ rows: [[{ id, name, animated }]] }].
// Lines that are nothing but a run of emojis, one after another, are one run of several rows; a
// run inside a line is a run of one row. Whether a run is one picture is isCombined's to say.
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
    .slice(0, MAX_CANDIDATES)
}

// The emojis in `texts` that are not the server's own (which have descriptions already) and not
// part of the combined emojis `groups`, each once: [{ id, name, animated }].
function foreignEmojis (texts, guild, groups = []) {
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

// Whether the run's names are one name numbered: nobaman_1 nobaman_2, a1 a2, part-01 part-02.
function numberedNames (group) {
  const tiles = group.rows.flat()
  const parts = tiles.map(e => e.name.match(/^(.*?[^\d_-])[_-]?(\d+)$/))
  if (parts.some(p => !p)) return false
  return new Set(parts.map(p => p[1].toLowerCase())).size === 1
}

const EDGE_OPAQUE = 128
const MIN_SHARED_EDGE = 0.25
const MAX_EDGE_DIFFERENCE = 48

// Whether the picture carries on across the edge where two tiles meet: along it, enough pixels
// are drawn on both sides, and they look alike. Separate emojis mostly have a clear margin there.
// a, b: raw RGBA pixels of TILE x TILE tiles; side: 'right' (b is right of a) or 'below'.
function continues (a, b, side) {
  let shared = 0
  let difference = 0
  for (let i = 0; i < TILE; i++) {
    const pa = side === 'right' ? (i * TILE + TILE - 1) * 4 : ((TILE - 1) * TILE + i) * 4
    const pb = side === 'right' ? (i * TILE) * 4 : i * 4
    if (a[pa + 3] < EDGE_OPAQUE || b[pb + 3] < EDGE_OPAQUE) continue
    shared++
    difference += (Math.abs(a[pa] - b[pb]) + Math.abs(a[pa + 1] - b[pb + 1]) + Math.abs(a[pa + 2] - b[pb + 2])) / 3
  }
  return shared >= TILE * MIN_SHARED_EDGE && difference / shared <= MAX_EDGE_DIFFERENCE
}

// Whether the tiles make one picture: at least half the edges where two of them meet carry the
// picture on. pixelsOf(id) resolves to a tile's raw RGBA pixels, or null.
async function isOnePicture (group, pixelsOf) {
  const edges = []
  for (const [y, row] of group.rows.entries()) {
    for (const [x, e] of row.entries()) {
      if (row[x + 1]) edges.push([e, row[x + 1], 'right'])
      if (group.rows[y + 1]?.[x]) edges.push([e, group.rows[y + 1][x], 'below'])
    }
  }
  let carried = 0
  for (const [a, b, side] of edges) {
    const [pa, pb] = await Promise.all([pixelsOf(a.id), pixelsOf(b.id)])
    if (pa && pb && continues(pa, pb, side)) carried++
  }
  return edges.length !== 0 && carried * 2 >= edges.length
}

// Whether a run of emojis is a combined emoji, not emojis written next to each other: not one
// emoji repeated, and named as parts or drawn as one picture.
async function isCombined (group, pixelsOf) {
  const ids = new Set(group.rows.flat().map(e => e.id))
  if (ids.size === 1) return false
  return numberedNames(group) || isOnePicture(group, pixelsOf)
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

// Tiles fetched once each: fetchTile(id) a TILE x TILE PNG, pixelsOf(id) its raw RGBA pixels.
function tileCache () {
  const tiles = new Map()
  const pixels = new Map()
  const fetchTile = id => {
    if (!tiles.has(id)) {
      tiles.set(id, urlFetcher.fetchImage(imageURL(id))
        .then(({ buffer }) => sharp(buffer, { animated: false }).resize(TILE, TILE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
        .catch(() => null))
    }
    return tiles.get(id)
  }
  const pixelsOf = id => {
    if (!pixels.has(id)) {
      pixels.set(id, fetchTile(id).then(png => png && sharp(png).ensureAlpha().raw().toBuffer()).catch(() => null))
    }
    return pixels.get(id)
  }
  return { fetchTile, pixelsOf }
}

// The runs of emojis that are combined emojis, and their pictures: { combined: [group], pictures }.
async function combinedPictures (groups, cache = tileCache()) {
  const combined = []
  const pictures = []
  for (const group of groups) {
    if (pictures.length === MAX_GROUPS) break
    if (!await isCombined(group, cache.pixelsOf).catch(() => false)) continue
    const picture = await stitch(group, cache.fetchTile).catch(() => null)
    if (picture) {
      combined.push(group)
      pictures.push(picture)
    }
  }
  return { combined, pictures }
}

// Everything to show the model for `texts`: combined emojis first, then other servers' emojis
// (emojis written next to each other that are not one picture among them, one by one).
async function picturesFor (texts, guild) {
  const { combined, pictures } = await combinedPictures(emojiGroups(texts))
  const foreign = await emojiPictures(foreignEmojis(texts, guild, combined))
  return [...pictures, ...foreign]
}

module.exports = { foreignEmojis, emojiPictures, emojiGroups, combinedPictures, picturesFor, isCombined, numberedNames, MAX_EMOJIS }
