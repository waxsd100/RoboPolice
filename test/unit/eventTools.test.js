const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
// Load first: it sets the environment the bot modules read when they are required.
const { createGuild, createMember, installBot } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const { createTools, formatMessage, StopDrafting } = require('../../src/bot/modules/eventTools')

const REQUESTER = '1'
const guild = createGuild({
  channels: [
    { id: '201', name: 'general', type: 0, readers: [REQUESTER, 'BOT'] },
    { id: '202', name: 'staff', type: 0, readers: ['BOT'] },
    { id: '203', name: 'bot-blind', type: 0, readers: [REQUESTER] },
    { id: '204', name: 'ボイス', type: 2, readers: [REQUESTER, 'BOT'] }
  ]
})
const otherGuild = createGuild({ id: '300', channels: [{ id: '301', name: 'elsewhere', readers: [REQUESTER, 'BOT'] }] })
const member = createMember({ id: REQUESTER })

const MESSAGES = {
  '201/401': { content: '11/3 19時から交流会', author: { id: '2', username: 'alice' } },
  '201/402': { content: '詳細はこちら', author: { id: '3', username: 'bob' } },
  '202/403': { content: 'スタッフだけの話', author: { id: '4', username: 'staff' } },
  '301/404': { content: '別サーバー', author: { id: '5', username: 'x' } }
}

let bot
beforeEach(() => {
  bot = installBot({ guilds: [guild, otherGuild], messages: MESSAGES, scheduledEvents: [] })
})

function tools (ask = async () => 'answer') {
  return createTools({ guild, member, ask })
}

describe('get_discord_message', () => {
  test('reads a message in a channel both can read and records the source', async () => {
    const t = tools()
    const res = await t.call('get_discord_message', { link: 'https://discord.com/channels/100/201/401' })
    assert.match(res.result, /alice \(2\): 11\/3 19時から交流会/)
    assert.deepEqual(t.sources, ['https://discord.com/channels/100/201/401'])
  })

  test('accepts ptb, canary and discordapp links', async () => {
    for (const host of ['ptb.discord.com', 'canary.discord.com', 'discordapp.com']) {
      const res = await tools().call('get_discord_message', { link: `https://${host}/channels/100/201/401` })
      assert.ok(res.result, host)
    }
  })

  test('refuses a channel the requester cannot read', async () => {
    const res = await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/202/403' })
    assert.match(res.error, /依頼者がこのチャンネル/)
  })

  test('refuses a channel the bot cannot read', async () => {
    const res = await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/203/1' })
    assert.match(res.error, /BOTがこのチャンネル/)
  })

  test('refuses another server, even when the link lies about the server', async () => {
    assert.match((await tools().call('get_discord_message', { link: 'https://discord.com/channels/300/301/404' })).error, /別のサーバー/)
    assert.match((await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/301/404' })).error, /このサーバーのチャンネルではありません/)
  })

  test('refuses something that is not a message link', async () => {
    assert.match((await tools().call('get_discord_message', { link: 'https://example.com' })).error, /メッセージリンクではありません/)
  })

  test('reports a deleted message as a tool error', async () => {
    assert.match((await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/201/999' })).error, /Unknown Message/)
  })
})

describe('fetch_url', () => {
  test('hands Discord message links to get_discord_message', async () => {
    const res = await tools().call('fetch_url', { url: 'https://discord.com/channels/100/201/401' })
    assert.match(res.result, /交流会/)
  })

  test('fetches other URLs and records the final URL', async (t) => {
    t.mock.method(urlFetcher, 'fetchPageText', async url => ({ url: `${url}?final`, text: 'page' }))
    const tl = tools()
    const res = await tl.call('fetch_url', { url: 'https://example.com/e' })
    assert.equal(res.result, 'page')
    assert.deepEqual(tl.sources, ['https://example.com/e?final'])
  })

  test('returns fetch failures to the model', async () => {
    const res = await tools().call('fetch_url', { url: 'http://127.0.0.1/' })
    assert.match(res.error, /プライベートアドレス/)
  })

  test('caps very long results', async (t) => {
    t.mock.method(urlFetcher, 'fetchPageText', async url => ({ url, text: 'x'.repeat(30000) }))
    const res = await tools().call('fetch_url', { url: 'https://example.com' })
    assert.equal(res.result.length, 20000)
  })
})

describe('get_recent_messages', () => {
  test('reads a readable channel', async () => {
    const res = await tools().call('get_recent_messages', { channel_id: '201', limit: 5 })
    assert.match(res.result, /交流会[\s\S]*詳細はこちら/)
  })

  test('clamps the limit to 1-50 and defaults to 20', async () => {
    for (const [limit, expected] of [[500, 50], [0, 20], [-3, 1], [undefined, 20], ['7', 7]]) {
      await tools().call('get_recent_messages', { channel_id: '201', limit })
      assert.equal(bot.at(-1).limit, expected, `limit ${limit}`)
    }
  })

  test('refuses a channel the requester cannot read', async () => {
    assert.match((await tools().call('get_recent_messages', { channel_id: '202' })).error, /依頼者がこのチャンネル/)
  })
})

describe('list_channels', () => {
  test('lists only channels the requester can see', async () => {
    const res = await tools().call('list_channels')
    assert.match(res.result, /201: general（text）/)
    assert.match(res.result, /204: ボイス（voice）/)
    assert.doesNotMatch(res.result, /staff/)
  })
})

describe('list_forums', () => {
  test('describes the forums both can post in, via the API', async () => {
    const g = createGuild({ channels: [{ id: '205', name: '募集', type: 15, posters: [REQUESTER, 'BOT'] }] })
    installBot({ guilds: [g], forums: { 205: { available_tags: [{ id: 't1', name: '募集中' }], flags: 16, topic: '題名に日付を' } } })
    const res = await createTools({ guild: g, member, ask: async () => '' }).call('list_forums')
    assert.equal(res.result, '- 205: 募集\n  タグ: 募集中（1つ以上必須）\n  投稿ガイドライン: 題名に日付を')
  })
})

describe('list_scheduled_events', () => {
  test('says when there are none', async () => {
    assert.equal((await tools().call('list_scheduled_events')).result, '登録済みのイベントはありません')
  })

  test('lists existing events', async () => {
    installBot({ guilds: [guild], scheduledEvents: [{ name: '既存', scheduled_start_time: '2026-11-03T10:00:00Z', scheduled_end_time: null, entity_metadata: { location: '渋谷' } }] })
    assert.match((await tools().call('list_scheduled_events')).result, /既存: 2026-11-03T10:00:00Z〜 渋谷/)
  })
})

describe('ask_user', () => {
  test('passes cleaned options and returns the answer', async () => {
    let asked
    const t = tools(async (question, options) => { asked = { question, options }; return options[1] })
    const res = await t.call('ask_user', { question: 'どれ？', options: [' A ', 'B', 'B', '', 'C', 'D', 'E'] })
    assert.deepEqual(asked, { question: 'どれ？', options: ['A', 'B', 'C', 'D'] })
    assert.equal(res.result, '依頼者の回答: B')
  })

  test('needs a question and at least two options', async () => {
    assert.match((await tools().call('ask_user', { question: 'q', options: ['only'] })).error, /2〜4個/)
    assert.match((await tools().call('ask_user', { options: ['a', 'b'] })).error, /2〜4個/)
  })

  test('allows three questions per draft', async () => {
    const t = tools()
    for (let i = 0; i < 3; i++) assert.ok((await t.call('ask_user', { question: 'q', options: ['a', 'b'] })).result)
    assert.match((await t.call('ask_user', { question: 'q', options: ['a', 'b'] })).error, /これ以上/)
  })

  test('lets StopDrafting end the draft instead of returning it to the model', async () => {
    const t = tools(async () => { throw new StopDrafting('やめました') })
    await assert.rejects(t.call('ask_user', { question: 'q', options: ['a', 'b'] }), StopDrafting)
  })
})

describe('declarations', () => {
  // Gemini answers 400 to an OBJECT schema with empty properties, so no-argument tools must omit
  // `parameters` entirely. This failed every drafting request in production.
  test('never send an empty parameters schema', () => {
    for (const d of tools().declarations) {
      if (!d.parameters) continue
      assert.ok(Object.keys(d.parameters.properties || {}).length > 0, `${d.name} has empty properties`)
    }
  })

  test('omit parameters for tools without arguments', () => {
    const byName = Object.fromEntries(tools().declarations.map(d => [d.name, d]))
    for (const name of ['list_channels', 'list_forums', 'list_scheduled_events']) {
      assert.equal(byName[name].parameters, undefined, name)
    }
  })
})

describe('call', () => {
  test('reports unknown tools', async () => {
    assert.match((await tools().call('drop_tables')).error, /不明なツール/)
  })
})

describe('formatMessage', () => {
  test('includes embeds and attachments', () => {
    const text = formatMessage({
      timestamp: Date.parse('2026-10-29T00:00:00Z'),
      author: { id: '2', username: 'alice' },
      content: '告知',
      embeds: [{ title: 'タイトル', fields: [{ name: '日時', value: '11/3' }], url: 'https://e.com', image: { url: 'https://cdn/banner.png' }, thumbnail: { url: 'https://cdn/thumb.png' } }],
      attachments: [{ filename: 'a.png', url: 'https://cdn/a.png' }]
    })
    assert.equal(text, [
      '[2026-10-29T00:00:00.000Z] alice (2): 告知',
      '  埋め込み: タイトル\n日時: 11/3\nhttps://e.com',
      '  埋め込み画像: https://cdn/banner.png',
      '  埋め込み画像: https://cdn/thumb.png',
      '  添付: a.png https://cdn/a.png'
    ].join('\n'))
  })
})

describe('describeServer', () => {
  const { describeServer } = require('../../src/bot/modules/eventTools')
  const { installYouTubeStore } = require('../helpers/fakes')

  function richGuild () {
    const g = createGuild({
      channels: [
        { id: '10', name: 'イベント', type: 4, readers: [REQUESTER] },
        { id: '11', name: 'お知らせ', type: 5, readers: [REQUESTER] },
        { id: '12', name: '雑談', type: 0, readers: [REQUESTER] },
        { id: '13', name: '運営', type: 0, readers: [] },
        { id: '14', name: 'ボイス', type: 2, readers: [REQUESTER] }
      ]
    })
    Object.assign(g, { name: 'のばまんサーバー', description: 'ゲーム好きの集まり', memberCount: 12000, rulesChannelID: '11' })
    Object.assign(g.channels.get('10'), { position: 0 })
    Object.assign(g.channels.get('11'), { parentID: '10', position: 0, topic: '運営からのお知らせ。\n書き込み禁止' })
    Object.assign(g.channels.get('12'), { parentID: '10', position: 1 })
    Object.assign(g.channels.get('14'), { position: 5 })
    g.roles.set(g.id, { id: g.id, name: '@everyone', position: 0 })
    g.roles.set('r1', { id: 'r1', name: 'メンバー', position: 1 })
    g.roles.set('r2', { id: 'r2', name: '運営', position: 3 })
    g.roles.set('r3', { id: 'r3', name: 'ロボポリス', position: 2, managed: true })
    return g
  }

  test('describes the server as the requester sees it, marking the request channel', async () => {
    installYouTubeStore()
    const g = richGuild()
    installBot({ guilds: [g], scheduledEvents: [{ name: '定例会', scheduled_start_time: '2026-11-03T10:00:00Z', entity_metadata: { location: '渋谷' } }] })
    const text = await describeServer(g, member, '12')
    assert.equal(text, [
      'サーバー名: のばまんサーバー',
      '説明: ゲーム好きの集まり',
      'メンバー数: 12000',
      'ルールチャンネル: <#11>',
      '',
      '### チャンネル（依頼者が見られるもの）',
      '[（カテゴリなし）]',
      '- 14: #ボイス（voice）',
      '[イベント]',
      '- 11: #お知らせ（announcement） — 運営からのお知らせ。 書き込み禁止',
      '- 12: #雑談（text） ← 依頼されたチャンネル',
      '',
      '### ロール',
      '運営, メンバー',
      '',
      '### 登録済みのイベント',
      '定例会: 2026-11-03T10:00:00Z〜 渋谷',
      '',
      '### YouTube',
      '設定なし'
    ].join('\n'))
  })

  test('mentions the stored YouTube channel', async () => {
    installYouTubeStore({ 100: { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: new Date('2026-10-29T12:00:00Z') }, videos: [{}, {}] } })
    const text = await describeServer(createGuild(), member, '1')
    assert.match(text, /### YouTube\nのばまんch（動画 2 件を保存、取得 2026-10-29T12:00:00\.000Z）。詳しくは search_youtube で調べる/)
  })

  test('still describes the server when events or YouTube cannot be read', async () => {
    const store = require('../../src/db/interfaces/postgres/youtube')
    store.getKnowledge = async () => { throw new Error('db down') }
    const g = createGuild()
    installBot({ guilds: [g] })
    global.bot.requestHandler.request = async () => { throw new Error('503') }
    const text = await describeServer(g, member, '1')
    assert.match(text, /### 登録済みのイベント\n（取得できませんでした: 503）/)
    assert.match(text, /### YouTube\n設定なし/)
  })
})

describe('search_youtube', () => {
  const { installYouTubeStore } = require('../helpers/fakes')
  const videos = [
    { title: '11/3 記念配信', description: '周年記念', live_status: 'upcoming', scheduled_start: new Date('2026-11-03T11:00:00Z'), published_at: new Date('2026-10-28T00:00:00Z'), url: 'https://y/v2' },
    { title: 'マイクラ 建築', description: '城を作る', live_status: 'none', published_at: new Date('2026-10-27T00:00:00Z'), duration: 'PT1H', url: 'https://y/v1' },
    { title: 'マイクラ 雑談', description: '', live_status: 'none', published_at: new Date('2026-10-20T00:00:00Z'), url: 'https://y/v0' }
  ]
  const synced = { channel_ref: '@x', title: 'のばまんch', url: 'https://y/c', description: 'ゲーム配信', synced_at: new Date('2026-10-29T12:00:00Z') }

  test('says when no channel is set, or it has not been read yet', async () => {
    installYouTubeStore()
    assert.match((await tools().call('search_youtube', {})).result, /YouTube チャンネルが設定されていません（運営が \/youtube set で設定できます）/)
    installYouTubeStore({ 100: { channel: { channel_ref: '@x', synced_at: null }, videos: [] } })
    assert.match((await tools().call('search_youtube', {})).result, /まだ情報を取得していません/)
  })

  test('lists videos with lives first when there is no query', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } })
    const text = (await tools().call('search_youtube', {})).result
    assert.equal(text, [
      'チャンネル: のばまんch（https://y/c）',
      '概要: ゲーム配信',
      '情報の取得日時: 2026-10-29T12:00:00.000Z（保存している動画 3 件、うち内容の要約あり 0 件）',
      '新しい順の動画:',
      '- [配信予定 2026-11-03T11:00:00.000Z] 11/3 記念配信（公開 2026-10-28）https://y/v2',
      '  周年記念',
      '- マイクラ 建築（公開 2026-10-27、長さ PT1H）https://y/v1',
      '  城を作る',
      '- マイクラ 雑談（公開 2026-10-20）https://y/v0'
    ].join('\n'))
  })

  test('matches every word of the query in the title or description, ignoring case', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } })
    const text = (await tools().call('search_youtube', { query: 'マイクラ  城' })).result
    assert.match(text, /「マイクラ {2}城」に一致した動画: 1 件\n- マイクラ 建築/)
    assert.doesNotMatch(text, /雑談/)
  })
})

describe('YouTube summaries in the tools', () => {
  const { installYouTubeStore, configureGateway, installGemini } = require('../helpers/fakes')
  const synced = { channel_ref: '@x', title: 'のばまんch', url: 'https://y/c', synced_at: new Date('2026-10-29T12:00:00Z') }
  const videos = [{ video_id: 'abcdefghijk', title: '雑談', description: '', live_status: 'none', published_at: new Date('2026-10-27T00:00:00Z'), url: 'https://www.youtube.com/watch?v=abcdefghijk' }]

  test('search_youtube also matches and shows what a video summary says', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } }, { 100: { abcdefghijk: '後半で 11/3 のオフ会を告知している' } })
    const text = (await tools().call('search_youtube', { query: 'オフ会' })).result
    assert.match(text, /保存している動画 1 件、うち内容の要約あり 1 件/)
    assert.match(text, /「オフ会」に一致した動画: 1 件\n- 雑談.*\n {2}内容の要約: 後半で 11\/3 のオフ会を告知している/)
  })

  test('search_youtube lists summaries of linked videos from other channels', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } }, { 100: { otherVideo1: '別チャンネルの勉強会の録画' } })
    const text = (await tools().call('search_youtube', { query: '勉強会' })).result
    assert.match(text, /その他の要約済み動画（1 件）:\n- https:\/\/www\.youtube\.com\/watch\?v=otherVideo1\n {2}内容の要約: 別チャンネルの勉強会の録画/)
  })

  test('search_youtube shows other summaries even when no channel is set', async () => {
    installYouTubeStore({}, { 100: { otherVideo1: '要約' } })
    const text = (await tools().call('search_youtube', {})).result
    assert.match(text, /YouTube チャンネルが設定されていません[\s\S]*その他の要約済み動画（1 件）/)
  })

  test('summarize_youtube_video returns the summary and records the video as a source', async () => {
    configureGateway()
    installYouTubeStore()
    installGemini([[{ text: '要点: 11/3 記念配信' }]])
    const t = tools()
    const res = await t.call('summarize_youtube_video', { url: 'https://youtu.be/abcdefghijk' })
    assert.equal(res.result, 'https://www.youtube.com/watch?v=abcdefghijk の内容の要約:\n要点: 11/3 記念配信')
    assert.deepEqual(t.sources, ['https://www.youtube.com/watch?v=abcdefghijk'])
    const again = await t.call('summarize_youtube_video', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })
    assert.match(again.result, /の内容の要約（保存済み）:/)
  })
})
