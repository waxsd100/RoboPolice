const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const { generateCover, buildPrompt } = require('../../src/bot/modules/imageGen')
const { SIZES } = require('../../src/bot/utils/imageCrop')
const { configureGateway, installGemini } = require('../helpers/fakes')

describe('buildPrompt', () => {
  test('asks for no text, and to base the image on the source when there is one', () => {
    const withSource = buildPrompt({ title: '秋の勉強会', summary: '参加無料', hasSource: true })
    assert.match(withSource, /titled "秋の勉強会"/)
    assert.match(withSource, /What it is about: 参加無料/)
    assert.match(withSource, /Base it on the attached image/)
    assert.match(withSource, /Do not draw any text/)
    assert.doesNotMatch(buildPrompt({ title: 'x', hasSource: false }), /attached image|What it is about/)
  })
})

describe('generateCover', () => {
  beforeEach(configureGateway)
  const generated = () => sharp({ create: { width: 1344, height: 576, channels: 3, background: '#22aa66' } }).png().toBuffer()

  test('uses the image model, the closest aspect ratio, and crops to the exact size', async () => {
    process.env.GEMINI_IMAGE_MODEL = 'image-model-x'
    try {
      const requests = installGemini([[{ inline_data: { mime_type: 'image/png', data: (await generated()).toString('base64') } }]])
      const out = await generateCover({ title: 'A', size: SIZES.forumImage })
      assert.match(requests[0].url, /models\/image-model-x:generateContent$/)
      assert.deepEqual(requests[0].body.generationConfig.imageConfig, { aspectRatio: '16:9' })
      assert.equal(requests[0].body.contents[0].parts.length, 1, 'no reference image was given')
      const meta = await sharp(out).metadata()
      assert.deepEqual([meta.width, meta.height], [1280, 720])
    } finally {
      delete process.env.GEMINI_IMAGE_MODEL
    }
  })

  test('sends the source as an inline JPEG reference', async () => {
    const requests = installGemini([[{ inlineData: { mimeType: 'image/png', data: (await generated()).toString('base64') } }]])
    await generateCover({ title: 'A', source: Buffer.from('jpeg-bytes'), size: SIZES.eventCover })
    assert.deepEqual(requests[0].body.contents[0].parts[1], { inlineData: { mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } })
    assert.deepEqual(requests[0].body.generationConfig.imageConfig, { aspectRatio: '21:9' })
  })

  test('fails with a hint when no image comes back', async () => {
    installGemini([[{ text: 'sorry' }]])
    await assert.rejects(generateCover({ title: 'A', size: SIZES.eventCover }), { hint: 'AI が画像を作れませんでした' })
  })
})
