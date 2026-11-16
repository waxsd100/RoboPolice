const { test } = require('node:test')
const assert = require('node:assert/strict')
const uncensoredImage = require('../../src/bot/utils/uncensoredImage')
const { takeImageRequests } = require('../../src/bot/modules/eventTools')
const { startServer } = require('../helpers/fakes')

test('reads as a child: only words that say one, and ages under 18', () => {
  for (const text of ['loli', 'shota', 'schoolgirl', 'a cute kid', '15 years old', '17yo', '12歳', '女子高生', 'JK制服', '小学生', 'ロリ', 'underage']) {
    assert.equal(uncensoredImage.readsAsMinor(text), true, text)
  }
  // An anime look is not a child: these are not refused.
  for (const text of ['1girl, adult woman, nude', '25 years old woman', '20歳の女性', 'eighteen', 'json api', 'adjustment of light', 'kidney beans', '少女', 'teen', 'school uniform', 'petite', 'high school']) {
    assert.equal(uncensoredImage.readsAsMinor(text), false, text)
  }
})

test('asks the image API (AUTOMATIC1111 style) and refuses a child before asking', async (t) => {
  const asked = []
  const srv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      asked.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
      res.writeHead(asked.length === 3 ? 400 : 200, { 'Content-Type': 'application/json' })
      res.end(asked.length === 3 ? '{"detail":"the prompt reads as a child: refused"}' : JSON.stringify({ images: [Buffer.from('png').toString('base64')] }))
    })
  })
  t.after(() => {
    delete process.env.UNCENSORED_IMAGE_API_URL
    delete process.env.UNCENSORED_IMAGE_API_KEY
    return srv.close()
  })
  assert.equal(uncensoredImage.isConfigured(), false)
  process.env.UNCENSORED_IMAGE_API_URL = `${srv.url}/sdapi/v1/`
  process.env.UNCENSORED_IMAGE_API_KEY = 'k'
  assert.equal(uncensoredImage.isConfigured(), true)

  const made = await uncensoredImage.generate({ prompt: '1girl, adult woman', aspectRatio: '16:9' })
  assert.deepEqual(made, { buffer: Buffer.from('png'), mimeType: 'image/png' })
  assert.equal(asked[0].url, '/sdapi/v1/txt2img')
  assert.equal(asked[0].auth, 'Bearer k')
  assert.deepEqual([asked[0].body.width, asked[0].body.height], [1344, 768])
  assert.equal(asked[0].body.prompt, '1girl, adult woman', 'nothing added to what was asked')
  assert.equal(asked[0].body.negative_prompt, uncensoredImage.NEGATIVE)
  assert.match(uncensoredImage.NEGATIVE, /^child, loli, shota, /)
  assert.doesNotMatch(uncensoredImage.NEGATIVE, /flat chest|petite|school uniform|young/)
  assert.equal(asked[0].body.init_images, undefined)

  await uncensoredImage.generate({ prompt: 'same, at night', sources: [{ buffer: Buffer.from('src') }] })
  assert.equal(asked[1].url, '/sdapi/v1/img2img')
  assert.deepEqual(asked[1].body.init_images, [Buffer.from('src').toString('base64')])

  await assert.rejects(uncensoredImage.generate({ prompt: 'loli, nude' }), /子ども・未成年に見える人物の画像は作れません/)
  assert.equal(asked.length, 2, 'not asked')
  await assert.rejects(uncensoredImage.generate({ prompt: 'something the server refuses' }), /子ども・未成年に見える人物の画像は作れません/)
})

test('takes the picture lines out of an uncensored reply, two at most', () => {
  assert.deepEqual(takeImageRequests('いいよ\n[[画像: 1girl, adult]]\n続き\n[[画像：beach]]\n[[画像: third]]'), { text: 'いいよ\n続き', tags: ['1girl, adult', 'beach'] })
  assert.deepEqual(takeImageRequests('画像なし'), { text: '画像なし', tags: [] })
})
