// Links in a chat reply: short in the text, videos as cards under it.
const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { installYouTubeStore } = require('../helpers/fakes')
const { withLinkCards } = require('../../src/bot/utils/linkCards')

describe('withLinkCards', () => {
  test('videos become cards with their title and channel; previews in the text are turned off', async () => {
    installYouTubeStore({ 100: { channel: { title: 'のばまんゲームス' }, videos: [{ video_id: 'abcdefghijk', title: '【マイクラ】城を建てる' }] } })
    const asked = []
    const fetchImpl = async url => { asked.push(url); return { ok: true, json: async () => ({ title: '別の動画', author_name: '別チャンネル' }) } }
    const { content, embeds } = await withLinkCards([
      'おすすめは [城づくり回](https://www.youtube.com/watch?v=abcdefghijk) だよ！',
      '[12:34](https://www.youtube.com/watch?v=abcdefghijk&t=754s) あたりが見どころ。',
      'こっちも https://youtu.be/zzzzzzzzzzz 、詳しくは https://example.com/page 。'
    ].join('\n'), { fetchImpl })
    assert.equal(content, [
      'おすすめは [城づくり回](<https://www.youtube.com/watch?v=abcdefghijk>) だよ！',
      '[12:34](<https://www.youtube.com/watch?v=abcdefghijk&t=754s>) あたりが見どころ。',
      'こっちも [別の動画](<https://youtu.be/zzzzzzzzzzz>) 、詳しくは <https://example.com/page> 。'
    ].join('\n'))
    assert.deepEqual(embeds.map(e => [e.title, e.url, e.author?.name, e.thumbnail.url]), [
      ['【マイクラ】城を建てる', 'https://www.youtube.com/watch?v=abcdefghijk', 'のばまんゲームス', 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'],
      ['別の動画', 'https://www.youtube.com/watch?v=zzzzzzzzzzz', '別チャンネル', 'https://i.ytimg.com/vi/zzzzzzzzzzz/hqdefault.jpg']
    ])
    assert.equal(asked.length, 1, 'only the video not stored is looked up')
  })

  test('a reply without links is left alone; a video that cannot be looked up still gets a card', async () => {
    installYouTubeStore()
    assert.deepEqual(await withLinkCards('こんにちは <:kusa:12>'), { content: 'こんにちは <:kusa:12>', embeds: [] })
    const { content, embeds } = await withLinkCards('https://youtu.be/zzzzzzzzzzz', { fetchImpl: async () => ({ ok: false }) })
    assert.equal(content, '<https://youtu.be/zzzzzzzzzzz>')
    assert.equal(embeds[0].title, 'YouTube の動画')
  })
})
