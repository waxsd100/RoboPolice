// Other servers' emojis in a request, shown to the model as images for that request only.
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const sharp = require('sharp')
const { foreignEmojis, emojiPictures, emojiGroups, combinedPictures, picturesFor } = require('../../src/bot/utils/foreignEmojis')

const id = n => String(n).padStart(18, '1')
const code = (name, n) => `<:${name}:${id(n)}>`
const png = color => sharp({ create: { width: 96, height: 96, channels: 4, background: color } }).png().toBuffer()

describe('foreignEmojis', () => {
  test('finds the emojis that are not the server\'s own, each once, a few at most', () => {
    const guild = { emojis: [{ id: '111111111111111111', name: 'kusa' }] }
    const found = foreignEmojis([
      'これ <:kusa:111111111111111111> と <a:dance:222222222222222222> <:dance:222222222222222222>',
      'user2: <:other:333333333333333333>',
      null
    ], guild)
    assert.deepEqual(found, [{ id: '222222222222222222', name: 'dance', animated: true }, { id: '333333333333333333', name: 'other', animated: false }])
    const many = Array.from({ length: 10 }, (_, i) => `<:e${i}:${String(i).padStart(18, '4')}>`).join(' ')
    assert.equal(foreignEmojis([many], guild).length, 6)
  })

  test('their images are fetched from Discord; one that cannot be is left out', async (t) => {
    const asked = []
    t.mock.method(urlFetcher, 'fetchImage', async url => {
      asked.push(url)
      if (url.includes('333')) throw new Error('404')
      return { buffer: Buffer.from('png'), contentType: 'image/png' }
    })
    const pictures = await emojiPictures([{ id: '222222222222222222', name: 'dance' }, { id: '333333333333333333', name: 'other' }])
    assert.deepEqual(asked, ['https://cdn.discordapp.com/emojis/222222222222222222.png?size=96', 'https://cdn.discordapp.com/emojis/333333333333333333.png?size=96'])
    assert.deepEqual(pictures, [{ name: 'dance', buffer: Buffer.from('png'), mimeType: 'image/png' }])
  })
})

describe('combined emojis', () => {
  // A tile drawn edge to edge in one colour, or a small dot in the middle with clear margins.
  const full = color => png(color)
  const dot = color => sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 40, height: 40, channels: 4, background: color } }, left: 28, top: 28 }]).png().toBuffer()
  const RED = { r: 255, g: 0, b: 0, alpha: 1 }
  const GREEN = { r: 0, g: 255, b: 0, alpha: 1 }
  const BLUE = { r: 0, g: 0, b: 255, alpha: 1 }
  function serve (t, images) {
    return t.mock.method(urlFetcher, 'fetchImage', async url => ({ buffer: await images[url.match(/emojis\/(\d+)/)[1]](), contentType: 'image/png' }))
  }

  test('runs of emojis are found on their own lines (as rows) or inside a line', () => {
    const text = [
      'これ見て',
      `${code('a1', 1)}${code('a2', 2)}`,
      `  ${code('b1', 3)}${code('b2', 4)}  `,
      `いいね ${code('x1', 5)}${code('x2', 6)}${code('x3', 7)} すごい ${code('solo', 8)}`
    ].join('\n')
    assert.deepEqual(emojiGroups([text]).map(g => g.rows.map(r => r.map(e => e.name))), [[['a1', 'a2'], ['b1', 'b2']], [['x1', 'x2', 'x3']]])
  })

  test('named as numbered parts: one picture, stitched in place, each tile fetched once', async (t) => {
    const fetched = serve(t, { [id(1)]: () => full(RED), [id(2)]: () => full(GREEN), [id(3)]: () => full(BLUE) })
    const { pictures } = await combinedPictures(emojiGroups([`${code('nobaman_1', 1)}${code('nobaman_2', 2)}\n${code('nobaman_3', 3)}${code('nobaman_1', 1)}`]))
    assert.equal(pictures.length, 1)
    assert.equal(pictures[0].name, ':nobaman_1::nobaman_2: / :nobaman_3::nobaman_1:')
    const { width, height } = await sharp(pictures[0].buffer).metadata()
    assert.deepEqual([width, height], [128, 128])
    const pixel = async (x, y) => [...(await sharp(pictures[0].buffer).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())].slice(0, 3)
    assert.deepEqual(await pixel(10, 10), [255, 0, 0])
    assert.deepEqual(await pixel(100, 10), [0, 255, 0])
    assert.deepEqual(await pixel(10, 100), [0, 0, 255])
    assert.deepEqual(await pixel(100, 100), [255, 0, 0])
    assert.equal(fetched.mock.callCount(), 3)
  })

  test('without numbered names, only tiles whose picture carries on across their edges are one', async (t) => {
    serve(t, { [id(1)]: () => full(RED), [id(2)]: () => full(RED), [id(3)]: () => dot(RED), [id(4)]: () => dot(GREEN), [id(5)]: () => full(GREEN) })
    const look = async text => (await combinedPictures(emojiGroups([text]))).pictures.length
    assert.equal(await look(`${code('left', 1)}${code('right', 2)}`), 1, 'the picture carries on')
    assert.equal(await look(`${code('kusa', 3)}${code('naki', 4)}`), 0, 'two emojis with margins, side by side')
    assert.equal(await look(`${code('red', 1)}${code('green', 5)}`), 0, 'touching, but the colours do not carry on')
    assert.equal(await look(`${code('kusa', 3)}${code('kusa', 3)}${code('kusa', 3)}`), 0, 'one emoji repeated')
  })

  test('picturesFor: combined emojis first, then other servers\' emojis, those not part of one included', async (t) => {
    serve(t, { [id(1)]: () => full(RED), [id(2)]: () => full(RED), [id(3)]: () => dot(RED), [id(4)]: () => dot(GREEN) })
    const pictures = await picturesFor([`${code('big1', 1)}${code('big2', 2)} と ${code('kusa', 3)}${code('naki', 4)}`], { emojis: [{ id: id(1) }, { id: id(2) }] })
    assert.deepEqual(pictures.map(p => [p.name, !!p.combined]), [[':big1::big2:', true], ['kusa', false], ['naki', false]])
  })
})
