const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { cropTo, fitWithBlur, defaultMode, forReference, SIZES } = require('../../src/bot/utils/imageCrop')

// A tall image with one bright, busy square near the bottom: an "interesting" region that a plain
// center crop would cut off.
async function tallImageWithSubjectNearBottom () {
  const subject = await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ff0000' } })
    .composite([{ input: await sharp({ create: { width: 100, height: 100, channels: 3, background: '#00ff00' } }).png().toBuffer(), top: 50, left: 50 }])
    .png().toBuffer()
  return sharp({ create: { width: 600, height: 1200, channels: 4, background: { r: 128, g: 128, b: 128, alpha: 0.5 } } })
    .composite([{ input: subject, top: 950, left: 200 }])
    .png().toBuffer()
}

describe('cropTo', () => {
  test('produces a JPEG of exactly the event cover size', async () => {
    const out = await cropTo(await tallImageWithSubjectNearBottom(), SIZES.eventCover)
    const meta = await sharp(out).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 800, 320])
  })

  test('produces the forum image size', async () => {
    const meta = await sharp(await cropTo(await tallImageWithSubjectNearBottom(), SIZES.forumImage)).metadata()
    assert.deepEqual([meta.width, meta.height], [1280, 720])
  })

  test('keeps the interesting region rather than the center', async () => {
    const out = await cropTo(await tallImageWithSubjectNearBottom(), SIZES.eventCover)
    const { channels } = await sharp(out).stats()
    // The red/green subject is in the crop: red and green dominate the flat gray background.
    assert.ok(channels[0].max > 200 && channels[1].max > 200, 'subject should be inside the crop')
  })

  test('rejects data that is not an image', async () => {
    await assert.rejects(fitWithBlur(Buffer.from('nope'), SIZES.eventCover))
  })

  test('crop rejects data that is not an image', async () => {
    await assert.rejects(cropTo(Buffer.from('<html>not an image</html>'), SIZES.eventCover))
  })
})

describe('fitWithBlur', () => {
  test('shows the whole image centered over a blurred fill, at exactly the target size', async () => {
    // A tall, pure red poster: shown whole it occupies the middle; the sides are blurred red.
    const poster = await sharp({ create: { width: 300, height: 600, channels: 3, background: '#ff0000' } }).png().toBuffer()
    const out = await fitWithBlur(poster, SIZES.eventCover)
    const meta = await sharp(out).metadata()
    assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 800, 320])
    // Middle column: the poster itself, full brightness. Edge column: the darkened fill.
    const pixel = async (left) => (await sharp(out).extract({ left, top: 160, width: 1, height: 1 }).raw().toBuffer())[0]
    assert.ok(await pixel(400) > 240, 'center is the original image')
    assert.ok(await pixel(5) < 230, 'edges are the darkened background')
  })
})

describe('defaultMode', () => {
  const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#888888' } }).png().toBuffer()

  test('crops images close to the target shape', async () => {
    assert.equal(await defaultMode(await image(1000, 420), SIZES.eventCover), 'crop')
    assert.equal(await defaultMode(await image(1920, 1080), SIZES.forumImage), 'crop')
  })

  test('shows posters and other far-off shapes whole', async () => {
    assert.equal(await defaultMode(await image(900, 1200), SIZES.eventCover), 'fit')
    assert.equal(await defaultMode(await image(1000, 1000), SIZES.eventCover), 'fit')
    assert.equal(await defaultMode(await image(600, 900), SIZES.forumImage), 'fit')
  })

  test('accounts for EXIF rotation', async () => {
    // Stored landscape 1000x420, but orientation 6 means it is displayed portrait.
    const rotated = await sharp(await image(1000, 420)).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    assert.equal(await defaultMode(rotated, SIZES.eventCover), 'fit')
  })
})

describe('forReference', () => {
  test('shrinks large images to at most 1536px as JPEG, and leaves small ones alone', async () => {
    const big = await sharp(await forReference(await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#123456' } }).png().toBuffer())).metadata()
    assert.deepEqual([big.format, big.width, big.height], ['jpeg', 1536, 768])
    const small = await sharp(await forReference(await sharp({ create: { width: 300, height: 200, channels: 3, background: '#123456' } }).png().toBuffer())).metadata()
    assert.deepEqual([small.width, small.height], [300, 200])
  })
})
