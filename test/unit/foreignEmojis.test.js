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
  test('rows of emojis on their own lines make one picture; a run inside a line is one row', () => {
    const text = [
      'これ見て',
      `${code('a1', 1)}${code('a2', 2)}`,
      `  ${code('b1', 3)}${code('b2', 4)}  `,
      `いいね ${code('x1', 5)}${code('x2', 6)}${code('x3', 7)} すごい ${code('solo', 8)}`
    ].join('\n')
    const groups = emojiGroups([text])
    assert.deepEqual(groups.map(g => g.rows.map(r => r.map(e => e.name))), [[['a1', 'a2'], ['b1', 'b2']], [['x1', 'x2', 'x3']]])
    assert.deepEqual(foreignEmojis([text], { emojis: [] }).map(e => e.name), ['solo'], 'tiles are not shown one by one')
  })

  test('the tiles are stitched in place, each fetched once, into one picture', async (t) => {
    const colors = { [id(1)]: { r: 255, g: 0, b: 0, alpha: 1 }, [id(2)]: { r: 0, g: 255, b: 0, alpha: 1 }, [id(3)]: { r: 0, g: 0, b: 255, alpha: 1 } }
    const fetched = t.mock.method(urlFetcher, 'fetchImage', async url => ({ buffer: await png(colors[url.match(/emojis\/(\d+)/)[1]]), contentType: 'image/png' }))
    const [picture] = await combinedPictures(emojiGroups([`${code('a1', 1)}${code('a2', 2)}\n${code('b1', 3)}${code('a1', 1)}`]))
    assert.equal(picture.name, ':a1::a2: / :b1::a1:')
    assert.equal(picture.combined, true)
    const { width, height } = await sharp(picture.buffer).metadata()
    assert.deepEqual([width, height], [128, 128])
    const pixel = async (x, y) => [...(await sharp(picture.buffer).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())].slice(0, 3)
    assert.deepEqual(await pixel(10, 10), [255, 0, 0])
    assert.deepEqual(await pixel(100, 10), [0, 255, 0])
    assert.deepEqual(await pixel(10, 100), [0, 0, 255])
    assert.deepEqual(await pixel(100, 100), [255, 0, 0])
    assert.equal(fetched.mock.callCount(), 3)
  })

  test('picturesFor: combined emojis first, then other servers\' emojis', async (t) => {
    t.mock.method(urlFetcher, 'fetchImage', async () => ({ buffer: await png({ r: 1, g: 2, b: 3, alpha: 1 }), contentType: 'image/png' }))
    const pictures = await picturesFor([`${code('a1', 1)}${code('a2', 2)} と ${code('other', 9)}`], { emojis: [{ id: id(1) }, { id: id(2) }] })
    assert.deepEqual(pictures.map(p => [p.name, !!p.combined]), [[':a1::a2:', true], ['other', false]])
  })
})
