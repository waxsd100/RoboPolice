const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { embeddableText } = require('../../src/bot/utils/messageNoise')

describe('messageNoise', () => {
  afterEach(() => { delete process.env.MESSAGE_EMBEDDING_MIN_CHARS })

  test('leaves out laughter, reactions and bare links, emojis or mentions', () => {
    for (const text of ['', 'w', 'wwwwwwww', 'ｗｗｗｗ', '草', '草草草草草草', '笑笑', 'おk', 'それな', '😂😂😂',
      '<:kusa:123456789012345678>', '<a:dance:123456789012345678> <@123456789012345678>',
      'https://youtu.be/abcdefghijk', '<#123456789012345678>', 'ーーーーーー', '!!!???']) {
      assert.equal(embeddableText(text), '', JSON.stringify(text))
    }
  })

  test('keeps what says something, without the links, emojis and mentions in it', () => {
    assert.equal(embeddableText('明日の配信何時から？'), '明日の配信何時から？')
    assert.equal(embeddableText('<@123456789012345678> この動画見た？ https://youtu.be/abcdefghijk 😂'), 'この動画見た？')
    assert.equal(embeddableText('ホラーゲームやろう'), 'ホラーゲームやろう')
    assert.equal(embeddableText('let us play tonight'), 'let us play tonight')
    assert.equal(embeddableText('すごーーーーーーい配信だった'), 'すごーーい配信だった')
  })

  test('numbers are not drawn-out letters', () => {
    assert.equal(embeddableText('10000円のガチャ'), '10000円のガチャ')
  })

  test('the length is a setting', () => {
    process.env.MESSAGE_EMBEDDING_MIN_CHARS = '2'
    assert.equal(embeddableText('それな'), 'それな')
    assert.equal(embeddableText('草草'), '', 'laughter stays out whatever the length')
  })
})
