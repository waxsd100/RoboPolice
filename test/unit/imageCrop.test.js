const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { cropTo, SIZES } = require('../../src/bot/utils/imageCrop')

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
    await assert.rejects(cropTo(Buffer.from('<html>not an image</html>'), SIZES.eventCover))
  })
})
