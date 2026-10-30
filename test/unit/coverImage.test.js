require('../helpers/fakes')
const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
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
    await cover.useDraft({ imageUrls: [...urls], title: 't2', summary: 's' })
    assert.equal(cover.selected, 1)
  })
})
