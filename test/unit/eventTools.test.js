const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
// Load first: it sets the environment the bot modules read when they are required.
const { createGuild, createMember, installBot } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const { unwrapTools } = require('../helpers/fakes')
const { createTools: rawCreateTools, formatMessage, withServerEmojis, withServerChannels, namedChannels, namedMembers, requestChannelInfo, StopDrafting } = require('../../src/bot/modules/eventTools')
const createTools = opts => unwrapTools(rawCreateTools(opts))

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

  test('a link to a channel reads its recent messages, if both can read it', async () => {
    const res = await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/201' })
    assert.match(res.result, /11\/3 19時から交流会/)
    assert.match((await tools().call('fetch_url', { url: 'https://discord.com/channels/100/201/' })).result, /詳細はこちら/)
    assert.match((await tools().call('get_discord_message', { link: 'https://discord.com/channels/100/202' })).error, /依頼者がこのチャンネル/)
    assert.match((await tools().call('get_discord_message', { link: 'https://discord.com/channels/300/301' })).error, /別のサーバー/)
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
    assert.equal(res.result.length, 10000)
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

describe('get_server_rules', () => {
  test('reads the server rules channel on demand', async (t) => {
    const serverRules = require('../../src/bot/modules/serverRules')
    t.mock.method(serverRules, 'readRules', async () => [{ channelID: '201', text: '1. 仲良くすること' }])
    const res = await tools().call('get_server_rules')
    assert.match(res.result, /### <#201> より\n1\. 仲良くすること/)
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
    for (const name of ['list_channels', 'list_forums', 'list_scheduled_events', 'get_server_rules']) {
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

describe('formatMessage labels', () => {
  test('in a conversation, marks the bot\'s own messages and the requester\'s', () => {
    const at = { timestamp: 0, content: 'x' }
    assert.match(formatMessage({ ...at, author: { id: 'BOT', username: 'ロボポリス' } }), /\] ロボポリス \(BOT\): x$/, 'plain outside a conversation')
    assert.match(formatMessage({ ...at, author: { id: 'BOT', username: 'ロボポリス' } }, REQUESTER), /\] あなた（BOT）: x$/)
    assert.match(formatMessage({ ...at, author: { id: REQUESTER, username: 'me' } }, REQUESTER), /\] me \(1\)（依頼者）: x$/)
    assert.match(formatMessage({ ...at, author: { id: '2', username: 'alice' } }, REQUESTER), /\] alice \(2\): x$/)
  })
})

describe('readThread', () => {
  const chain = {
    '201/601': { content: 'おすすめの動画は？', author: { id: REQUESTER, username: 'me' } },
    '201/602': { content: '〇〇がおすすめ！', author: { id: 'BOT', username: 'bot' }, messageReference: { messageID: '601', channelID: '201' } },
    '201/603': { content: 'それの続編は？', author: { id: REQUESTER, username: 'me' }, messageReference: { messageID: '602' } },
    '201/604': { content: '続編は△△だよ', author: { id: 'BOT', username: 'bot' }, messageReference: { messageID: '603', channelID: '201' } }
  }

  test('follows the replies back, oldest first, with the bot\'s replies as its own', async () => {
    installBot({ guilds: [guild], messages: chain })
    const thread = await tools().readThread('201', '604')
    assert.equal(thread.count, 4)
    assert.deepEqual(thread.text.split('\n').map(l => l.replace(/^\[[^\]]+\] /, '')), [
      'me (1)（依頼者）: おすすめの動画は？',
      'あなた（BOT）: 〇〇がおすすめ！',
      'me (1)（依頼者）: それの続編は？',
      'あなた（BOT）: 続編は△△だよ'
    ])
    // What knowledge is looked up by: the members' side only.
    assert.deepEqual(thread.othersText.split('\n').map(l => l.replace(/^\[[^\]]+\] /, '')), [
      'me (1)（依頼者）: おすすめの動画は？',
      'me (1)（依頼者）: それの続編は？'
    ])
  })

  test('stops at 10 messages and at a deleted one', async () => {
    const long = {}
    for (let i = 1; i <= 15; i++) long[`201/${700 + i}`] = { content: `m${i}`, author: { id: '2', username: 'a' }, ...(i > 1 ? { messageReference: { messageID: String(699 + i) } } : {}) }
    installBot({ guilds: [guild], messages: long })
    const thread = await tools().readThread('201', '715')
    assert.equal(thread.count, 10)
    assert.match(thread.text, /^\[[^\]]+\] a \(2\): m6\n/)

    installBot({ guilds: [guild], messages: { '201/604': chain['201/604'] } })
    assert.equal((await tools().readThread('201', '604')).count, 1)
  })

  test('refuses a channel the requester cannot read, and a missing first message', async () => {
    await assert.rejects(tools().readThread('202', '403'), /依頼者がこのチャンネル/)
    await assert.rejects(tools().readThread('201', '999'), /Unknown Message/)
  })

  test('collects image URLs from attachments and embeds across the reply chain', async () => {
    installBot({
      guilds: [guild],
      messages: {
        '201/610': {
          content: 'この画像見て',
          author: { id: REQUESTER, username: 'me' },
          attachments: [{ filename: 'cat.png?ex=1', url: 'https://cdn.example/cat.png?ex=1' }],
          embeds: [{ image: { url: 'https://cdn.example/banner.jpg' } }]
        },
        '201/611': {
          content: 'かわいい！',
          author: { id: 'BOT', username: 'bot' },
          messageReference: { messageID: '610', channelID: '201' }
        }
      }
    })
    const thread = await tools().readThread('201', '611')
    assert.deepEqual(thread.images, ['https://cdn.example/cat.png?ex=1', 'https://cdn.example/banner.jpg'])
  })
})

describe('withServerEmojis', () => {
  const g = { emojis: [{ id: '11', name: 'nobaman_wave' }, { id: '12', name: 'party', animated: true }, { id: '13', name: 'staffonly', roles: ['801'] }] }

  test('turns :name: of a server emoji into its code and leaves everything else alone', () => {
    assert.equal(
      withServerEmojis('やっほー :nobaman_wave: 今日も :party: <:nobaman_wave:11> :unknown: :staffonly: 10:30:00 https://e.com', g),
      'やっほー <:nobaman_wave:11> 今日も <a:party:12> <:nobaman_wave:11> :unknown: :staffonly: 10:30:00 https://e.com'
    )
  })

  test('takes emojis out of code formatting, where Discord shows them as text', () => {
    assert.equal(
      withServerEmojis('・`<a:party:12>`（踊る）\n・`:nobaman_wave:` と ``<:nobaman_wave:11> <a:party:12>``\n```\n<:nobaman_wave:11>\n```', g),
      '・<a:party:12>（踊る）\n・<:nobaman_wave:11> と <:nobaman_wave:11> <a:party:12>\n<:nobaman_wave:11>'
    )
    assert.equal(withServerEmojis('`npm run test` と `:unknown:`', g), '`npm run test` と `:unknown:`', 'other code and unknown emojis stay')
  })

  test('a server emoji written with a wrong ID or a wrong a: gets its own code', () => {
    assert.equal(withServerEmojis('<:party:12> <a:nobaman_wave:99> <:other:55>', g), '<a:party:12> <:nobaman_wave:11> <:other:55>')
  })

  test('resolves usable owner-server extraEmojis while keeping the current server\'s own emoji on :name: collisions', () => {
    const localGuild = { emojis: [{ id: '21', name: 'wave' }] }
    const ownerEmojis = [
      { id: '91', name: 'wave', animated: true },
      { id: '92', name: 'yotsuron_happy' },
      { id: '93', name: 'owner_staff', roles: ['r9'] },
      { id: '94', name: 'owner_broken', available: false }
    ]
    assert.equal(
      withServerEmojis('こんにちは :wave: `:yotsuron_happy:` <:wave:91> <a:yotsuron_happy:999> :owner_staff: :owner_broken:', localGuild, ownerEmojis),
      'こんにちは <:wave:21> <:yotsuron_happy:92> <a:wave:91> <:yotsuron_happy:92> :owner_staff: :owner_broken:',
      'bare :wave: resolves to local server emoji 21, exact ID 91 keeps owner animated emoji, owner-only emoji unwraps and fixes wrong ID/a:'
    )
    assert.equal(
      withServerEmojis('こんにちは :yotsuron_happy:', localGuild, []),
      'こんにちは :yotsuron_happy:',
      'when externalEmojis are disallowed (extraEmojis empty), owner emoji names are not converted'
    )
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
    g.emojis = [
      { id: '31', name: 'nobaman_wave' },
      { id: '32', name: 'party', animated: true },
      { id: '33', name: 'subonly', roles: ['r1'] },
      { id: '34', name: 'broken', available: false }
    ]
    return g
  }

  test('describes the server compactly and leaves channel listings to list_channels', async () => {
    installYouTubeStore()
    const g = richGuild()
    installBot({ guilds: [g], scheduledEvents: [{ name: '定例会', scheduled_start_time: '2026-11-03T10:00:00Z', entity_metadata: { location: '渋谷' } }] })
    const text = await describeServer(g, member, '12')
    assert.equal(text, [
      'サーバー名: のばまんサーバー',
      '説明: ゲーム好きの集まり',
      'メンバー数: 12000',
      'ルールチャンネル: <#11>（内容は get_server_rules で読む）',
      '',
      '### サーバー絵文字（返事で使うときは、この書き方のまま書く）',
      '<:nobaman_wave:31> <a:party:32>',
      '',
      '### YouTube',
      '設定なし'
    ].join('\n'))
    const channels = await createTools({ guild: g, member, ask: async () => '' }).call('list_channels')
    assert.equal(channels.result, [
      '14: ボイス（voice）',
      '11: お知らせ（announcement） [イベント] — 運営からのお知らせ。 書き込み禁止',
      '12: 雑談（text） [イベント]'
    ].join('\n'))
  })

  test('mentions the stored YouTube channel', async () => {
    installYouTubeStore({ 100: { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: new Date('2026-10-29T12:00:00Z') }, videos: [{}, {}] } })
    const text = await describeServer(createGuild(), member, '1')
    assert.match(text, /### YouTube\nのばまんch（動画 2 件を保存、取得 2026-10-29T12:00:00\.000Z）\n詳しくは search_youtube で調べる/)
  })

  test('scheduled events are not read for the profile: the model asks for them when it needs them', async () => {
    const g = createGuild()
    const calls = installBot({ guilds: [g], scheduledEvents: [{ name: '定例会', scheduled_start_time: '2026-11-03T10:00:00Z' }] })
    installYouTubeStore()
    const text = await describeServer(g, member, '1')
    assert.doesNotMatch(text, /定例会|登録済みのイベント/)
    assert.deepEqual(calls.filter(c => c.method === 'GET'), [])
  })

  test('still describes the server when YouTube cannot be read', async () => {
    const store = require('../../src/db/interfaces/postgres/youtube')
    store.getOverview = async () => { throw new Error('db down') }
    const g = createGuild()
    installBot({ guilds: [g] })
    global.bot.requestHandler.request = async () => { throw new Error('503') }
    const text = await describeServer(g, member, '1')
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
    assert.match((await tools().call('search_youtube', {})).result, /BOT が見ている YouTube チャンネルはありません/)
    installYouTubeStore({ 100: { channel: { channel_ref: '@x', synced_at: null }, videos: [] } })
    assert.match((await tools().call('search_youtube', {})).result, /まだ情報を取得していません/)
  })

  test('lists videos with lives first when there is no query', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } })
    const text = (await tools().call('search_youtube', {})).result
    assert.equal(text, [
      'チャンネル: のばまんch（https://y/c、取得 2026-10-29T12:00:00.000Z）',
      '  概要: ゲーム配信',
      '保存している動画 3 件、うち内容の要約あり 0 件',
      '新しい順の動画:',
      '- [配信予定 2026-11-03T20:00:00+09:00] 11/3 記念配信（公開 2026-10-28）https://y/v2',
      '  周年記念',
      '- マイクラ 建築（公開 2026-10-27、長さ 1時間）https://y/v1',
      '  城を作る',
      '- マイクラ 雑談（公開 2026-10-20）https://y/v0'
    ].join('\n'))
  })

  test('ranks by meaning when the videos have embeddings, so other wording finds them', async () => {
    const { configureGateway, installEmbeddingModel, installEmbeddingStore } = require('../helpers/fakes')
    configureGateway()
    installYouTubeStore({ 100: { channel: synced, videos: videos.map(v => ({ ...v, video_id: v.url.slice(-2) })) } })
    installEmbeddingModel()
    const { embed, toBase64 } = require('../../src/bot/utils/embeddings')
    const [minecraft, other] = await embed(['マイクラ', 'その他'])
    installEmbeddingStore({ videos: { 100: { v1: toBase64(minecraft), v0: toBase64(minecraft), v2: toBase64(other) } } })
    const text = (await tools().call('search_youtube', { query: 'minecraft の建築' })).result
    assert.match(text, /「minecraft の建築」に意味が近い順の動画（語をすべて含むもの 0 件を優先）:\n- マイクラ 建築/)
    assert.ok(text.indexOf('マイクラ 雑談') < text.indexOf('記念配信'), 'the stream comes after the videos close in meaning')
  })

  test('matches every word of the query in the title or description, ignoring case', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } })
    const text = (await tools().call('search_youtube', { query: 'マイクラ  城' })).result
    assert.match(text, /「マイクラ {2}城」に一致した動画: 1 件\n- マイクラ 建築/)
    assert.doesNotMatch(text, /雑談/)
  })

  test('strips recommendation meta-words instead of matching 0 titles, and falls back to stored videos (summarized first) when no keyword or embedding matches', async () => {
    const withIds = videos.map((v, i) => ({ ...v, video_id: `vid${i}` }))
    installYouTubeStore({ 100: { channel: synced, videos: withIds } }, { 100: { vid2: '雑談の神回まとめ' } })
    const metaText = (await tools().call('search_youtube', { query: 'のばまん 隠れた 名作 おすすめ 動画' })).result
    assert.match(metaText, /新しい順の動画:\n- \[配信予定/)
    assert.doesNotMatch(metaText, /一致した動画: 0 件/)

    const fallbackText = (await tools().call('search_youtube', { query: 'プリペア神企画' })).result
    assert.match(fallbackText, /「プリペア神企画」に一致した動画: 0 件/)
    assert.match(fallbackText, /指定の語が直接含まれる動画はありませんでした。以下は保存済みの動画です/)
    assert.ok(fallbackText.indexOf('マイクラ 雑談') < fallbackText.indexOf('マイクラ 建築'), 'summarized videos come first in fallback')
  })

  test('formats JST dates across UTC midnight, stream start times, exact counts, and sorts by views or oldest', async () => {
    installYouTubeStore({
      100: {
        channel: { ...synced, subscriber_count: 625000, view_count: 245000000 },
        videos: [
          {
            video_id: 'vid_latejst',
            title: '深夜投稿動画',
            description: '',
            live_status: 'none',
            // 2026-10-27 16:30 UTC == 2026-10-28 01:30 JST
            published_at: new Date('2026-10-27T16:30:00Z'),
            duration: 'PT12M34S',
            view_count: 152300,
            like_count: 8420,
            comment_count: 512,
            stats_updated_at: new Date(),
            url: 'https://www.youtube.com/watch?v=vid_latejst'
          },
          {
            video_id: 'vid_archive',
            title: '長時間配信アーカイブ',
            description: '',
            live_status: 'none',
            actual_start: new Date('2026-10-20T11:00:00Z'),
            // Waiting room created days earlier: stream time must still be shown clearly
            published_at: new Date('2026-10-18T03:00:00Z'),
            duration: 'PT3H5M',
            view_count: 1250000,
            stats_updated_at: new Date(),
            url: 'https://www.youtube.com/watch?v=vid_archive'
          },
          {
            video_id: 'vid_oldest1',
            title: '初投稿テスト',
            description: '',
            live_status: 'none',
            published_at: new Date('2020-04-01T09:00:00Z'),
            duration: 'PT45S',
            view_count: 980,
            stats_updated_at: new Date(),
            url: 'https://www.youtube.com/watch?v=vid_oldest1'
          }
        ]
      }
    })

    const byViews = (await tools().call('search_youtube', { query: '一番再生数が多い動画' })).result
    assert.match(byViews, /登録者 625,000人（62万5,000人）、総再生 245,000,000回（2億4,500万回）/)
    assert.match(byViews, /再生数の多い順の動画（3 件）:\n- 長時間配信アーカイブ（配信 2026-10-20T20:00:00\+09:00、公開 2026-10-18、長さ 3時間5分、再生 1,250,000回（125万回））/)
    assert.match(byViews, /- 深夜投稿動画（公開 2026-10-28、長さ 12分34秒、再生 152,300回（15万2,300回）、高評価 8,420、コメント 512件）/)

    const oldest = (await tools().call('search_youtube', { query: '一番古い動画' })).result
    assert.match(oldest, /古い順の動画:\n- 初投稿テスト（公開 2020-04-01、長さ 45秒、再生 980回）/)
  })

  test('refreshes live video statistics and resolves direct YouTube URLs in search_youtube and fetch_url', async () => {
    const prevKey = process.env.YOUTUBE_API_KEY
    process.env.YOUTUBE_API_KEY = 'yt-test-key'
    const origFetch = global.fetch
    try {
      const store = installYouTubeStore({
        100: {
          channel: { ...synced, channel_id: 'UCown0000000000000000000' },
          videos: [{
            video_id: 'ownVideo001',
            title: '既存動画',
            description: '概要テスト',
            live_status: 'none',
            published_at: new Date('2026-10-25T10:00:00Z'),
            duration: 'PT10M',
            view_count: 100,
            stats_updated_at: new Date('2026-10-01T00:00:00Z'),
            url: 'https://www.youtube.com/watch?v=ownVideo001'
          }]
        }
      })
      global.fetch = async url => {
        const ids = new URL(url).searchParams.get('id').split(',')
        return {
          ok: true,
          json: async () => ({
            items: ids.map(id => id === 'ownVideo001'
              ? {
                  id: 'ownVideo001',
                  snippet: { channelId: 'UCown0000000000000000000', channelTitle: 'のばまんch', title: '既存動画', description: '概要テスト', publishedAt: '2026-10-25T10:00:00Z', liveBroadcastContent: 'none' },
                  contentDetails: { duration: 'PT10M' },
                  statistics: { viewCount: '54321', likeCount: '2100', commentCount: '99' }
                }
              : {
                  id,
                  snippet: { channelId: 'UCext0000000000000000000', channelTitle: '外部チャンネル', title: '外部コラボ動画', description: 'コラボ概要', publishedAt: '2026-11-01T15:30:00Z', liveBroadcastContent: 'none' },
                  contentDetails: { duration: 'PT25M' },
                  statistics: { viewCount: '333333', likeCount: '9999', commentCount: '444' }
                })
          })
        }
      }

      const refreshed = (await tools().call('search_youtube', { query: '既存動画' })).result
      assert.match(refreshed, /再生 54,321回（5万4,321回）、高評価 2,100、コメント 99件/)
      assert.equal(store.knowledge[100].videos[0].view_count, 54321, 'updated view count persisted in store')

      const fetched = (await tools().call('fetch_url', { url: 'https://youtu.be/extVideo002' })).result
      assert.match(fetched, /動画情報（YouTube Data API \/ 保存データ）:/)
      assert.match(fetched, /題名: 外部コラボ動画/)
      assert.match(fetched, /チャンネル: 外部チャンネル/)
      assert.match(fetched, /公開日時（日本時間）: 2026-11-02T00:30:00\+09:00（公開日: 2026-11-02）/)
      assert.match(fetched, /再生回数: 333,333回（33万3,333回）/)
    } finally {
      global.fetch = origFetch
      process.env.YOUTUBE_API_KEY = prevKey
    }
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

  test('search_youtube gives each video its URL, and a summary\'s times as links into the video', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } }, { 100: { abcdefghijk: '- [3:05] オフ会の告知' } })
    const text = (await tools().call('search_youtube', { query: 'オフ会' })).result
    assert.match(text, /- 雑談（公開 2026-10-27）https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk/)
    assert.match(text, /内容の要約: - \[3:05\]\(https:\/\/www\.youtube\.com\/watch\?v=abcdefghijk&t=185s\) オフ会の告知/)
  })

  test('search_youtube lists summaries of linked videos from other channels', async () => {
    installYouTubeStore({ 100: { channel: synced, videos } }, { 100: { otherVideo1: '別チャンネルの勉強会の録画' } })
    const text = (await tools().call('search_youtube', { query: '勉強会' })).result
    assert.match(text, /その他の要約済み動画（1 件）:\n- https:\/\/www\.youtube\.com\/watch\?v=otherVideo1\n {2}内容の要約: 別チャンネルの勉強会の録画/)
  })

  test('search_youtube shows other summaries even when no channel is set', async () => {
    installYouTubeStore({}, { 100: { otherVideo1: '要約' } })
    const text = (await tools().call('search_youtube', {})).result
    assert.match(text, /BOT が見ている YouTube チャンネルはありません[\s\S]*その他の要約済み動画（1 件）/)
  })

  test('summarize_youtube_video returns the summary and records the video as a source', async () => {
    configureGateway()
    installYouTubeStore()
    installGemini([[{ text: '要点: 11/3 記念配信' }]])
    const shown = []
    const t = createTools({ guild, member, ask: async () => '', progress: text => shown.push(text) })
    const res = await t.call('summarize_youtube_video', { url: 'https://youtu.be/abcdefghijk' })
    assert.deepEqual(shown, ['動画の内容を読み取っています…（長い動画は数分かかります。最大 10 分）'])
    assert.equal(res.result, 'https://www.youtube.com/watch?v=abcdefghijk の内容の要約:\n要点: 11/3 記念配信')
    assert.deepEqual(t.sources, ['https://www.youtube.com/watch?v=abcdefghijk'])
    const again = await t.call('summarize_youtube_video', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })
    assert.match(again.result, /の内容の要約（保存済み）:/)
  })
})

describe('channels in replies', () => {
  test('#name of a channel the requester can see becomes a link; other # stay', () => {
    assert.equal(withServerChannels('雑談は #general で、ボイスは #ボイス へ。#staff は秘密', guild, member), '雑談は <#201> で、ボイスは <#204> へ。#staff は秘密')
    assert.equal(withServerChannels('<#201> と https://x.com/a#general と #generalist', guild, member), '<#201> と https://x.com/a#general と #generalist')
  })

  test('the channels a message names, with what they are', () => {
    assert.deepEqual(namedChannels(['<#201> を見て', 'https://discord.com/channels/100/204 と <#202> と <#999>'], guild, member), [
      '- <#201>: #general（text）',
      '- <#204>: #ボイス（voice）'
    ])
    assert.deepEqual(namedChannels(['https://discord.com/channels/300/301'], guild, member), [], 'another server\'s')
  })
})

describe('who is who', () => {
  test('who asked, and the members a message names, by their names', () => {
    global.bot = { ...global.bot, user: { id: 'BOT' } }
    const members = new Map([
      ['11', { id: '11', nick: 'わこち', username: 'wakokara' }],
      ['22', { id: '22', user: { globalName: 'くらじー', username: 'desu_crazy' } }],
      ['33', { id: '33', username: 'otherbot', bot: true }]
    ])
    const g = { members }
    const requester = members.get('11')
    assert.deepEqual(namedMembers(['<@22> ってどんな人？ <@!33> と <@11> と <@BOT> と <@99>', '<@22> また'], g, requester), [
      '- 依頼した人（このメッセージを書いた人）: わこち（@wakokara、ID: 11）',
      '- <@22>: くらじー（@desu_crazy）',
      '- <@33>: otherbot（@otherbot、BOT）',
      '- <@11>: わこち（@wakokara）（依頼した人本人）'
    ])
    assert.deepEqual(namedMembers(['なし'], g, null), [])
  })
})

describe('requestChannelInfo', () => {
  test('the request channel with its kind, category and description; a thread with the channel it is in', () => {
    const g = createGuild({
      channels: [
        { id: '10', name: '雑談部屋', type: 4 },
        { id: '11', name: 'general', type: 0 },
        { id: '12', name: '募集', type: 15 }
      ]
    })
    Object.assign(g.channels.get('11'), { parentID: '10', topic: 'なんでも\n話す場所' })
    Object.assign(g.channels.get('12'), { topic: '一緒に遊ぶ人を募集' })
    installBot({ guilds: [g] })
    const thread = { id: '13', name: '金曜の募集', type: 11, parentID: '12', guild: g }
    const getChannel = global.bot.getChannel
    global.bot.getChannel = id => id === '13' ? thread : getChannel(id)
    assert.equal(requestChannelInfo('11', g), '#general（ID: 11、text、カテゴリ「雑談部屋」）\n  チャンネルの説明: なんでも 話す場所')
    assert.equal(requestChannelInfo('13', g), '#金曜の募集（ID: 13、thread、<#12>（#募集）の中のスレッド）\n  親チャンネルの説明: 一緒に遊ぶ人を募集')
    assert.equal(requestChannelInfo('999', g), null)
    // An age-restricted channel says so, and so does a thread in one.
    g.channels.get('12').nsfw = true
    assert.match(requestChannelInfo('13', g), /^#金曜の募集（ID: 13、thread、年齢制限あり、/)
    g.channels.get('11').nsfw = true
    assert.match(requestChannelInfo('11', g), /^#general（ID: 11、text、年齢制限あり、カテゴリ/)
  })
})

describe('worthSearching', () => {
  const { worthSearching } = require('../../src/bot/modules/eventTools')

  test('a greeting, emojis, mentions or a link alone are not looked up by meaning', () => {
    for (const text of ['おはよう', 'w', '<@123> <:kusa:45> ！！', 'https://example.com/a/very/long/path', '草草草']) assert.equal(worthSearching(text), false, text)
    for (const text of ['よつろんって何色？', '面白すぎて草', 'マイクラの話して']) assert.equal(worthSearching(text), true, text)
  })
})

describe('about_member', () => {
  const { installLoreStore } = require('../helpers/fakes')
  function withMembers () {
    guild.members.set('2', { id: '2', username: 'alice', nick: 'アリス', roles: ['r1'], joinedAt: Date.parse('2025-04-01T00:00:00Z') })
    guild.members.set('3', { id: '3', username: 'alicia', roles: [] })
    guild.roles.set('r1', { id: 'r1', name: '常連', position: 2 })
  }

  test('finds a member by nickname, mention or ID, with roles and recent messages the requester can read; nothing kept', async (t) => {
    withMembers()
    require('../helpers/fakes').configureGateway()
    process.env.SERVER_LORE = 'true'
    t.after(() => { delete process.env.SERVER_LORE })
    installLoreStore({
      messages: [
        { guild_id: '100', channel_id: '201', author_id: '2', ts: '2026-10-30T10:00:00Z', content: 'マイクラやろう' },
        { guild_id: '100', channel_id: '202', author_id: '2', ts: '2026-10-31T10:00:00Z', content: 'スタッフだけの話' },
        { guild_id: '100', channel_id: '201', author_id: '2', ts: '2026-11-01T10:00:00Z', content: '昨日のボス強かった' }
      ]
    })
    for (const who of ['アリス', '<@2>', '<@!2>']) {
      const { result } = await tools().call('about_member', { member: who })
      assert.match(result, /表示名: アリス（@alice、ID: 2）/, who)
      assert.match(result, /ロール: 常連/)
      assert.match(result, /サーバーに参加: 2025-04-01/)
      assert.match(result, /\[2026-11-01\] #general: 昨日のボス強かった\n\[2026-10-30\] #general: マイクラやろう/)
      assert.doesNotMatch(result, /スタッフだけの話/)
    }
  })

  test('without SERVER_LORE, only what Discord shows: no messages are read', async () => {
    withMembers()
    installLoreStore({ messages: [{ guild_id: '100', channel_id: '201', author_id: '2', ts: '2026-11-01T10:00:00Z', content: '昨日のボス強かった' }] })
    const { result } = await tools().call('about_member', { member: 'アリス' })
    assert.match(result, /ロール: 常連/)
    assert.doesNotMatch(result, /ボス/)
    assert.match(result, /発言は参照しない設定/)
  })

  test('several matches are listed to be asked about; none is an error', async () => {
    withMembers()
    assert.match((await tools().call('about_member', { member: 'ali' })).result, /複数います[\s\S]*アリス[\s\S]*alicia/)
    assert.match((await tools().call('about_member', { member: 'ぼぶ' })).error, /見つかりません/)
  })
})

describe('channelTheme', () => {
  const { channelTheme } = require('../../src/bot/modules/eventTools')

  test('extracts non-generic channel names, parent channel themes for threads, and topics while ignoring generic channels', () => {
    const g = createGuild({
      channels: [
        { id: '10', name: 'general', type: 0 },
        { id: '11', name: '💬｜雑談-1', type: 0 },
        { id: '12', name: '📺｜01_のばまんの動画について語る✨', type: 0 },
        { id: '13', name: 'bot-commands', type: 0 }
      ]
    })
    Object.assign(g.channels.get('11'), { topic: 'なんでも自由に雑談' })
    Object.assign(g.channels.get('12'), { topic: '過去動画の感想や名作を語る場所' })
    installBot({ guilds: [g] })
    const genericThread = { id: '14', name: '質問', type: 11, parentID: '12', guild: g }
    const specificThread = { id: '15', name: 'プリペア回', type: 11, parentID: '12', guild: g }
    const foreignChannel = { id: '16', name: 'マイクラ建築', type: 0, guild: { id: '999' } }
    const getChannel = global.bot.getChannel
    global.bot.getChannel = id => ({ 14: genericThread, 15: specificThread, 16: foreignChannel }[id] || getChannel(id))

    assert.equal(channelTheme('10', g), '')
    assert.equal(channelTheme('11', g), '')
    assert.equal(channelTheme('13', g), '')
    assert.equal(channelTheme('12', g), 'のばまんの動画について語る — 過去動画の感想や名作を語る場所')
    assert.equal(channelTheme('14', g), 'のばまんの動画について語る — 過去動画の感想や名作を語る場所')
    assert.equal(channelTheme('15', g), 'プリペア回 — のばまんの動画について語る — 過去動画の感想や名作を語る場所')
    assert.equal(channelTheme('16', g), '')
    assert.equal(channelTheme(null, g, 'マイクラ建築'), 'マイクラ建築')
    assert.equal(channelTheme(null, g, '雑談'), '')
  })
})

describe('describeServer: what the server is like', () => {
  const { describeServer } = require('../../src/bot/modules/eventTools')
  const { installYouTubeStore, installLoreStore, installEmbeddingModel, configureGateway } = require('../helpers/fakes')

  test('the server\'s style and knowledge go into the profile', async (t) => {
    configureGateway()
    process.env.SERVER_LORE = 'true'
    t.after(() => { delete process.env.SERVER_LORE })
    installYouTubeStore()
    installLoreStore({ styles: { 100: 'ゆるくて、ツッコミが多い' } })
    const text = await describeServer(guild, member, '201')
    assert.match(text, /### このサーバーのノリ（メンバーの会話から）\nゆるくて、ツッコミが多い/)
    installLoreStore()
  })

  test('steers server lore toward a themed channel when the request omits the subject, while leaving #general and reply threads unsteered', async (t) => {
    configureGateway()
    process.env.SERVER_LORE = 'true'
    installYouTubeStore()
    installEmbeddingModel()
    const { embed, toBase64 } = require('../../src/bot/utils/embeddings')
    const [minecraftVec, horrorVec] = await embed(['マイクラ建築', '怖いホラー'])
    installLoreStore({
      facts: {
        100: [
          { kind: 'ネタ', name: '天空城プロジェクト', content: 'マイクラで作られた巨大城', week: '2026-10', embedding: toBase64(minecraftVec) },
          { kind: 'ネタ', name: '深夜ホラー絶叫回', content: '怖いゲームの配信', week: '2026-10', embedding: toBase64(horrorVec) }
        ]
      }
    })
    guild.channels.set('210', {
      id: '210',
      name: 'マイクラ建築',
      type: 0,
      guild,
      permissionsOf: () => ({ has: () => true })
    })
    installBot({ guilds: [guild] })
    t.after(() => {
      delete process.env.SERVER_LORE
      guild.channels.delete('210')
      installLoreStore()
    })

    const inGeneral = await describeServer(guild, member, '201', { query: '隠れた名作教えて' })
    assert.doesNotMatch(inGeneral, /天空城プロジェクト|深夜ホラー絶叫回/)

    const inThemed = await describeServer(guild, member, '210', { query: '隠れた名作教えて' })
    assert.match(inThemed, /天空城プロジェクト/)
    assert.doesNotMatch(inThemed, /深夜ホラー絶叫回/)

    const shortInThemed = await describeServer(guild, member, '210', { query: '名作は？' })
    assert.match(shortInThemed, /天空城プロジェクト/)

    const replyOverride = await describeServer(guild, member, '210', { query: 'おすすめ教えて', context: 'さっき怖いホラー配信の話をしてた' })
    assert.match(replyOverride, /深夜ホラー絶叫回/)
    assert.doesNotMatch(replyOverride, /天空城プロジェクト/)
  })

  test('slim mode omits heavy YouTube/Twitch/Steam/metadata sections while keeping server name, style, and up to 8 emoji codes', async (t) => {
    configureGateway()
    process.env.SERVER_LORE = 'true'
    t.after(() => {
      delete process.env.SERVER_LORE
      delete guild.emojis
      delete guild.description
      delete guild.memberCount
      delete guild.rulesChannelID
      installLoreStore()
    })
    installYouTubeStore({ 100: { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: new Date('2026-10-29T12:00:00Z') }, videos: [{}] } })
    installLoreStore({ styles: { 100: 'ゆるい雰囲気' }, facts: [{ id: 1, fact: '内輪ネタA' }] })
    guild.description = '詳しい説明'
    guild.memberCount = 9999
    guild.rulesChannelID = '201'
    guild.emojis = Array.from({ length: 12 }, (_, i) => ({ id: String(800 + i), name: `em${i}` }))
    const slimText = await describeServer(guild, member, '201', { slim: true })
    assert.match(slimText, /^サーバー名: /)
    assert.match(slimText, /### このサーバーのノリ（メンバーの会話から）\nゆるい雰囲気/)
    assert.match(slimText, /### サーバー絵文字（返事で使うときは、この書き方のまま書く）\n<:em0:800>/)
    assert.doesNotMatch(slimText, /<:em8:808>/, 'capped at 8 emojis')
    assert.doesNotMatch(slimText, /### YouTube|説明:|メンバー数:|ルールチャンネル:|内輪ネタA/)
  })

  test('offers owner-server emojis in other servers when externalEmojis is permitted, without starving local emojis, and falls back to DB across shards', async (t) => {
    const emojiStore = require('../../src/db/interfaces/postgres/emojis')
    const { sharedOwnerEmojis } = require('../../src/bot/modules/eventTools')
    configureGateway()
    installYouTubeStore()
    installEmbeddingModel()

    const prevOwner = process.env.OWNER_GUILD_IDS
    process.env.OWNER_GUILD_IDS = '9001'

    const ownerGuild = createGuild({ id: '9001', channels: [{ id: '910', name: 'general', readers: ['BOT'] }] })
    ownerGuild.emojis = Array.from({ length: 10 }, (_, i) => ({
      id: `90000000000000000${i}`,
      name: i === 7 ? 'yotsuron_horror' : `nobaman_${i}`,
      animated: i === 7
    }))
    ownerGuild.emojis.push({ id: '900000000000000099', name: 'sub_only', roles: ['sub'] })

    const otherGuild = createGuild({
      id: '200',
      channels: [
        { id: '201', name: '雑談', readers: [REQUESTER, 'BOT'] },
        { id: '202', name: '外部絵文字禁止', readers: [REQUESTER, 'BOT'], externalEmojis: false }
      ]
    })
    // Thread inside the external-emoji-restricted channel inherits parent's denial when lacking permissionsOf
    otherGuild.channels.set('203', { id: '203', name: '制限スレッド', type: 11, parentID: '202', guild: otherGuild })
    otherGuild.emojis = [
      { id: '200000000000000001', name: 'local_one' },
      { id: '200000000000000002', name: 'local_two' }
    ]

    t.after(() => {
      if (prevOwner === undefined) delete process.env.OWNER_GUILD_IDS
      else process.env.OWNER_GUILD_IDS = prevOwner
      installBot({ guilds: [guild] })
    })

    const descCalls = []
    const nearestCalls = []
    t.mock.method(emojiStore, 'descriptions', async target => {
      descCalls.push(target)
      return Object.fromEntries(ownerGuild.emojis.slice(0, 10).map((e, i) => [
        e.id,
        i === 7 ? 'よつろんが怖がっている。ホラー配信の話で使う' : `のばまんスタンプ${i}`
      ]))
    })
    t.mock.method(emojiStore, 'nearestEmojis', async (target, _vec, _model, limit) => {
      nearestCalls.push({ target, limit })
      // Put emoji #7 first, followed by the rest of ownerGuild's embedded emojis (localGuild has no embeddings)
      return ['900000000000000007', ...ownerGuild.emojis.slice(0, 10).filter((_, i) => i !== 7).map(e => e.id)]
    })

    // 1. Live owner guild in global.bot.guilds + externalEmojis permitted:
    //    ranks owner emojis by meaning AND keeps both local undescribed emojis within the 8-emoji cap.
    installBot({ guilds: [ownerGuild, otherGuild] })
    const profile = await describeServer(otherGuild, member, '201', { query: '怖いホラー配信おすすめ教えて' })
    assert.deepEqual(descCalls[0], ['200', '9001'])
    assert.deepEqual(nearestCalls[0].target, ['200', '9001'])
    assert.match(profile, /- <a:yotsuron_horror:900000000000000007> よつろんが怖がっている。ホラー配信の話で使う/)
    assert.match(profile, /- <:local_one:200000000000000001>/)
    assert.match(profile, /- <:local_two:200000000000000002>/)
    assert.doesNotMatch(profile, /sub_only/, 'role-restricted owner emojis are never shared')

    // 2. Slim mode when local server has 6 own emojis and owner server has 10: shares the 8 slots between both.
    otherGuild.emojis = Array.from({ length: 6 }, (_, i) => ({ id: `20000000000000001${i}`, name: `local_${i}` }))
    const slimMixed = await describeServer(otherGuild, member, '201', { slim: true })
    assert.match(slimMixed, /<:local_0:200000000000000010>/)
    assert.match(slimMixed, /<:nobaman_0:900000000000000000>/)
    otherGuild.emojis = [{ id: '200000000000000001', name: 'local_one' }]

    // 3. Channel (and child thread) where externalEmojis is denied for BOT: only local emojis are offered.
    assert.deepEqual(await sharedOwnerEmojis(otherGuild, '202'), [])
    assert.deepEqual(await sharedOwnerEmojis(otherGuild, '203'), [])
    const restrictedProfile = await describeServer(otherGuild, member, '202', { query: '怖いホラー配信おすすめ教えて' })
    assert.match(restrictedProfile, /<:local_one:200000000000000001>/)
    assert.doesNotMatch(restrictedProfile, /yotsuron_horror|nobaman_/)

    // 4. Cross-shard fallback: owner guild is NOT in global.bot.guilds, loaded from emojiStore.listEmojis instead.
    installBot({ guilds: [otherGuild] })
    const listMock = t.mock.method(emojiStore, 'listEmojis', async ids => {
      assert.deepEqual(ids, ['9001'])
      return [{ id: '900000000000000007', guild_id: '9001', name: 'yotsuron_horror', animated: true }]
    })
    const fromDbProfile = await describeServer(otherGuild, member, '201', { query: '怖いホラー配信おすすめ教えて' })
    assert.equal(listMock.mock.callCount(), 1)
    assert.match(fromDbProfile, /<a:yotsuron_horror:900000000000000007>/)
  })
})
