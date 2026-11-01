// Other servers' emojis in a request, shown to the model as images for that request only.
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const { foreignEmojis, emojiPictures } = require('../../src/bot/utils/foreignEmojis')

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
