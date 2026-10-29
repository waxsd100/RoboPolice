const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const { createTools, formatMessage, StopDrafting } = require('../../src/bot/modules/eventTools')
const { createGuild, createMember, installBot } = require('../helpers/fakes')

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
      embeds: [{ title: 'タイトル', fields: [{ name: '日時', value: '11/3' }], url: 'https://e.com' }],
      attachments: [{ filename: 'a.png', url: 'https://cdn/a.png' }]
    })
    assert.equal(text, [
      '[2026-10-29T00:00:00.000Z] alice (2): 告知',
      '  埋め込み: タイトル\n日時: 11/3\nhttps://e.com',
      '  添付: a.png https://cdn/a.png'
    ].join('\n'))
  })
})
