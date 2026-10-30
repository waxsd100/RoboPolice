const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { toForumPost, describeForums, postableForums, imageUrlsOf, REQUIRE_TAG } = require('../../src/bot/modules/forumPost')
const { createGuild, createMember, installBot } = require('../helpers/fakes')

const REQUESTER = '1'
const member = createMember({ id: REQUESTER })
const guild = createGuild({
  channels: [
    { id: '301', name: '募集', type: 15, posters: [REQUESTER, 'BOT'] },
    { id: '302', name: 'スタッフ用', type: 15, posters: ['BOT'] },
    { id: '303', name: 'BOT不可', type: 15, posters: [REQUESTER] },
    { id: '304', name: 'メディア', type: 16, posters: [REQUESTER, 'BOT'], moderators: ['BOT'] },
    { id: '305', name: 'general', type: 0, posters: [REQUESTER, 'BOT'] }
  ]
})
const FORUMS = {
  301: { available_tags: [{ id: 't1', name: '募集中' }, { id: 't2', name: '締切' }, { id: 't3', name: '運営のみ', moderated: true }], flags: 0, topic: '題名に日付を入れてください' },
  304: { available_tags: [{ id: 'm1', name: '公式', moderated: true }, { id: 'm2', name: '写真' }], flags: REQUIRE_TAG }
}

let calls
beforeEach(() => {
  calls = installBot({ guilds: [guild], forums: FORUMS })
})

const base = { found: true, channel_id: '301', title: '11/3 交流会の参加者募集', content: '参加したい人はこのスレッドに書き込んでください', tags: ['募集中'] }

describe('imageUrlsOf', () => {
  test('accepts only plain http(s) URLs', () => {
    assert.deepEqual(imageUrlsOf({ image_urls: [' https://e.com/a.png '] }), ['https://e.com/a.png'])
    for (const bad of ['', 'javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///etc/passwd', 'https://e.com/a b.png', undefined, 42]) {
      assert.deepEqual(imageUrlsOf({ image_urls: [bad] }), [], String(bad))
    }
    assert.deepEqual(imageUrlsOf({ image_urls: 'https://e.com/a.png' }), [])
  })

  test('keeps the order, drops duplicates and keeps at most 4', () => {
    const urls = ['https://e.com/1.png', 'https://e.com/2.png', 'https://e.com/1.png', 'https://e.com/3.png', 'https://e.com/4.png', 'https://e.com/5.png']
    assert.deepEqual(imageUrlsOf({ image_urls: urls }), ['https://e.com/1.png', 'https://e.com/2.png', 'https://e.com/3.png', 'https://e.com/4.png'])
  })

  test('also accepts a single image_url', () => {
    assert.deepEqual(imageUrlsOf({ image_url: 'https://e.com/a.png' }), ['https://e.com/a.png'])
  })

  test('is carried on a forum post', async () => {
    assert.deepEqual((await toForumPost({ ...base, image_urls: ['https://e.com/a.png'] }, guild, member)).imageUrls, ['https://e.com/a.png'])
  })
})

describe('postableForums', () => {
  test('only forum and media channels both the requester and the bot can post in', () => {
    assert.deepEqual(postableForums(guild, member).map(c => c.id), ['301', '304'])
  })
})

describe('describeForums', () => {
  test('lists tags the bot may apply, required-tag notes and guidelines', async () => {
    assert.equal(await describeForums(guild, member), [
      '- 301: 募集',
      '  タグ: 募集中, 締切',
      '  投稿ガイドライン: 題名に日付を入れてください',
      '- 304: メディア',
      '  タグ: 公式, 写真（1つ以上必須）'
    ].join('\n'))
  })

  test('says so when there is nowhere to post', async () => {
    assert.match(await describeForums(guild, createMember({ id: '999' })), /投稿できるフォーラムはありません/)
  })
})

describe('toForumPost', () => {
  test('builds a thread request with tag IDs and mentions disabled', async () => {
    assert.deepEqual(await toForumPost(base, guild, member), {
      post: {
        channelID: '301',
        name: '11/3 交流会の参加者募集',
        message: { content: '参加したい人はこのスレッドに書き込んでください', allowed_mentions: { parse: [] } },
        applied_tags: ['t1']
      },
      tagNames: ['募集中'],
      imageUrls: [],
      truncated: false
    })
    assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['GET /channels/301'])
  })

  test('matches tags case-insensitively, drops unknown and duplicate ones, keeps at most 5', async () => {
    const many = { 401: { available_tags: 'abcdefg'.split('').map(n => ({ id: n, name: n.toUpperCase() })) } }
    installBot({ guilds: [guild], forums: { ...FORUMS, 301: many[401] } })
    const { post } = await toForumPost({ ...base, tags: ['a', 'A', 'b', 'nope', 'c', 'd', 'e', 'f'] }, guild, member)
    assert.deepEqual(post.applied_tags, ['a', 'b', 'c', 'd', 'e'])
  })

  test('drops moderated tags unless the bot can manage threads', async () => {
    const { post } = await toForumPost({ ...base, tags: ['運営のみ', '締切'] }, guild, member)
    assert.deepEqual(post.applied_tags, ['t2'])
    const media = await toForumPost({ ...base, channel_id: '304', tags: ['公式'] }, guild, member)
    assert.deepEqual(media.post.applied_tags, ['m1'])
  })

  test('requires a tag where the forum does', async () => {
    const { error } = await toForumPost({ ...base, channel_id: '304', tags: [] }, guild, member)
    assert.match(error, /タグが必須/)
  })

  test('truncates long content and says so', async () => {
    const result = await toForumPost({ ...base, content: 'あ'.repeat(2500), title: 't'.repeat(150) }, guild, member)
    assert.equal(result.post.message.content.length, 2000)
    assert.equal(result.post.name.length, 100)
    assert.equal(result.truncated, true)
  })

  test('passes through the model reason when nothing was decided', async () => {
    assert.deepEqual(await toForumPost({ found: false, reason: '投稿先が分かりません' }, guild, member), { error: '投稿先が分かりません' })
  })

  for (const [name, change, pattern] of [
    ['an unknown channel', { channel_id: '999' }, /見つかりませんでした/],
    ['a text channel', { channel_id: '305' }, /見つかりませんでした/],
    ['a forum the requester cannot post in', { channel_id: '302' }, /依頼者が <#302> に投稿する権限/],
    ['a forum the bot cannot post in', { channel_id: '303' }, /BOTが <#303> に投稿する権限/],
    ['a missing title', { title: ' ' }, /題名/],
    ['missing content', { content: '' }, /本文/]
  ]) {
    test(`rejects ${name}`, async () => {
      assert.match((await toForumPost({ ...base, ...change }, guild, member)).error, pattern)
    })
  }
})
