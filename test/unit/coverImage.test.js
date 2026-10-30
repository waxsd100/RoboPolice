require('../helpers/fakes')
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
// Replaced before coverImage takes its reference to it.
const imageGen = require('../../src/bot/modules/imageGen')
let generated = 0
imageGen.generateCover = async ({ size }) => {
  generated++
  return sharp({ create: { ...size, channels: 3, background: `#0000${String(generated).padStart(2, '0')}` } }).jpeg().toBuffer()
}
const { CoverImage } = require('../../src/bot/modules/coverImage')
const { SIZES } = require('../../src/bot/utils/imageCrop')

const images = {}
const original = urlFetcher.fetchImage
beforeEach(async () => {
  images['https://e.com/wide.png'] = await sharp({ create: { width: 1000, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer()
  images['https://e.com/tall.png'] = await sharp({ create: { width: 400, height: 1000, channels: 3, background: '#00ff00' } }).png().toBuffer()
  urlFetcher.fetchImage = async url => {
    if (!images[url]) throw new Error('HTTP 404')
    return { buffer: images[url] }
  }
})
afterEach(() => { urlFetcher.fetchImage = original })

describe('CoverImage', () => {
  test('selects the first candidate in the mode that suits it, with a sheet of every candidate', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: ['https://e.com/wide.png', 'https://e.com/tall.png'], title: 't', summary: 's' })
    assert.equal(cover.candidates.length, 2)
    assert.equal(cover.selected, 0)
    assert.equal(cover.mode, 'crop')
    assert.ok(cover.sheet)
    assert.deepEqual((await sharp(cover.buffer).metadata()).width, 800)
    assert.match(cover.describe(), /^画像1・切り抜き（800×320）\n候補 2 枚/)
  })

  test('choosing another candidate switches to its default mode', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: ['https://e.com/wide.png', 'https://e.com/tall.png'], title: 't', summary: 's' })
    const first = cover.buffer
    await cover.choose(1)
    assert.equal(cover.selected, 1)
    assert.equal(cover.mode, 'fit')
    assert.notDeepEqual(cover.buffer, first)
    assert.match(cover.describe(), /^画像2・全体表示/)
    await cover.choose(0)
    assert.equal(cover.buffer, first, 'renderings are kept')
  })

  test('drops candidates that cannot be read and says so', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: ['https://e.com/missing.png', 'https://e.com/wide.png'], title: 't', summary: 's' })
    assert.equal(cover.candidates.length, 1)
    assert.equal(cover.sheet, null)
    assert.equal(cover.describe(), '切り抜き（800×320）\n使えなかった画像: HTTP 404')
  })

  test('has no image without candidates, and offers only AI or none', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: [], title: 't', summary: 's' })
    assert.equal(cover.buffer, null)
    assert.deepEqual(cover.modes(), ['ai', 'none'])
    assert.equal(cover.describe(), 'なし')
  })

  test('keeps the selection when a correction proposes the same candidates', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    const urls = ['https://e.com/wide.png', 'https://e.com/tall.png']
    await cover.useDraft({ imageUrls: urls, title: 't', summary: 's' })
    await cover.choose(1)
    await cover.revise({ imageUrls: [...urls], title: 't2', summary: 's' })
    assert.equal(cover.selected, 1)
  })

  test('a correction keeps the chosen image and only adds new candidates', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: ['https://e.com/wide.png'], title: 't', summary: 's' })
    await cover.pick('image:fit')
    const before = cover.buffer
    await cover.revise({ imageUrls: ['https://e.com/tall.png'], title: 't2', summary: 's2' })
    assert.equal(cover.mode, 'fit')
    assert.equal(cover.selected, 0)
    assert.equal(cover.buffer, before)
    assert.deepEqual(cover.candidates.map(c => c.url), ['https://e.com/wide.png', 'https://e.com/tall.png'])
    assert.ok(cover.sheet, 'the new candidate is shown to pick from')
  })

  test('a correction does not redraw an AI image; pressing AI again does', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: [], title: 't', summary: 's' })
    await cover.pick('image:ai')
    const count = generated
    const made = cover.buffer
    await cover.revise({ imageUrls: [], title: 't2', summary: 's' })
    assert.equal(generated, count)
    assert.equal(cover.buffer, made)
    assert.match(cover.describe(), /^AIで作成（800×320）\n内容を修正する前に作った画像です/)
    assert.ok(cover.needsAiRender())
    await cover.pick('image:ai')
    assert.equal(generated, count + 1)
    assert.notEqual(cover.buffer, made)
    assert.equal(cover.describe(), 'AIで作成（800×320）')
  })

  test('a correction that brings the first image of a draft without one selects it', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: [], title: 't', summary: 's' })
    await cover.revise({ imageUrls: ['https://e.com/wide.png'], title: 't', summary: 's' })
    assert.equal(cover.mode, 'crop')
    assert.ok(cover.buffer)
  })

  test('…unless the requester chose no image', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: [], title: 't', summary: 's' })
    await cover.pick('image:none')
    await cover.revise({ imageUrls: ['https://e.com/wide.png'], title: 't', summary: 's' })
    assert.equal(cover.mode, 'none')
  })

  test('an existing image is kept until another is picked', async () => {
    const current = { buffer: images['https://e.com/wide.png'] }
    const cover = new CoverImage(SIZES.eventCover, { current })
    await cover.useDraft({ imageUrls: ['https://e.com/tall.png'], title: 't', summary: 's' })
    assert.equal(cover.mode, 'keep')
    assert.equal(cover.buffer, current.buffer)
    assert.deepEqual(cover.modes(), ['keep', 'ai', 'none'])
    assert.equal(cover.describe(), '今の画像のまま')
    await cover.pick('candidate:0')
    assert.equal(cover.mode, 'fit')
  })

  test('switching size redoes the choice at the new size and crops an AI image instead of redrawing it', async () => {
    const cover = new CoverImage(SIZES.eventCover)
    await cover.useDraft({ imageUrls: ['https://e.com/wide.png'], title: 't', summary: 's' })
    await cover.resize(SIZES.forumImage)
    assert.deepEqual([(await sharp(cover.buffer).metadata()).width, cover.mode], [1280, 'crop'])
    await cover.pick('image:ai')
    const count = generated
    await cover.resize(SIZES.eventCover)
    assert.equal(generated, count)
    assert.equal((await sharp(cover.buffer).metadata()).width, 800)
  })
})
