// Integration: a mention runs through the real mentionEvent -> eventDrafter -> eventTools ->
// urlFetcher chain and the real interactionCreate button handling. Only Discord's API and Gemini
// are faked; web pages come from a local HTTP server.
const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
// Load first: it sets the environment the bot modules read when they are required.
const {
  createGuild, createMember, installBot, configureGateway, installGemini, call, submit, lastToolResponses, startServer
} = require('../helpers/fakes')
const Eris = require('eris')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const interactionCreate = require('../../src/bot/events/interactionCreate')
const mentionEvent = require('../../src/bot/modules/mentionEvent')

const REQUESTER = '1'
const OTHER_USER = '2'
const guild = createGuild({
  channels: [
    { id: '201', name: 'general', type: 0, readers: [REQUESTER, OTHER_USER, 'BOT'] },
    { id: '202', name: 'staff', type: 0, readers: ['BOT'] },
    { id: '204', name: 'ボイス', type: 2, readers: [REQUESTER, 'BOT'] },
    { id: '206', name: '募集', type: 15, posters: [REQUESTER, 'BOT'] },
    { id: '207', name: '運営連絡', type: 15, posters: ['BOT'] }
  ]
})
const FORUMS = {
  206: { available_tags: [{ id: 'tag-open', name: '募集中' }, { id: 'tag-staff', name: '運営', moderated: true }], flags: 16, topic: '題名に日付を入れる' },
  207: { available_tags: [] }
}
const MESSAGES = {
  '201/401': { content: '【告知】11/3(火) 19:00〜21:00 #ボイス で交流会をやります', author: { id: '3', username: 'organizer' } },
  '202/403': { content: 'スタッフ会議 11/5 20時', author: { id: '4', username: 'staff' } }
}

// The channel the mention is posted in. Records every message the bot shows there.
function createChannel () {
  const channel = guild.channels.get('201')
  const replies = []
  channel.createMessage = async payload => {
    const reply = { state: { content: '', embeds: [], components: [] }, history: [] }
    reply.apply = update => {
      reply.state = { ...reply.state, ...update }
      reply.history.push(reply.state)
    }
    reply.apply(payload)
    reply.edit = async update => reply.apply(update)
    replies.push(reply)
    return reply
  }
  return { channel, replies }
}

function mention (channel, content, { author = REQUESTER, member = createMember({ id: author }), messageReference } = {}) {
  return { id: '500', content, author: { id: author, username: `user${author}` }, member, channel, messageReference }
}

function buttons (reply) {
  return (reply.state.components[0]?.components || []).map(b => ({ label: b.label, id: b.custom_id }))
}

async function waitFor (predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function waitForButtons (reply, label) {
  await waitFor(() => buttons(reply).some(b => b.label === label), `button "${label}"`)
  return buttons(reply)
}

// Presses a button through the real interactionCreate handler, as Discord would deliver it.
function press (reply, label, userID = REQUESTER) {
  const button = buttons(reply).find(b => b.label === label)
  assert.ok(button, `no "${label}" button; have ${buttons(reply).map(b => b.label)}`)
  const interaction = Object.create(Eris.ComponentInteraction.prototype)
  Object.assign(interaction, {
    applicationID: 'BOT',
    data: { custom_id: button.id },
    member: { user: { id: userID } },
    acknowledge: async () => {},
    editOriginalMessage: async update => reply.apply(update)
  })
  // Resolves once the waiting code has received the click; never resolves for an ignored click.
  return interactionCreate.handle(interaction)
}

describe('mention → event / forum post (integration)', () => {
  let site
  let discord
  before(async () => {
    site = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><head><title>秋の勉強会</title>
        <script type="application/ld+json">{"@type":"Event","name":"秋の勉強会","startDate":"2026-11-07T13:00:00+09:00","endDate":"2026-11-07T17:00:00+09:00","location":{"name":"渋谷ホール"}}</script>
        </head><body><p>参加無料</p></body></html>`)
    })
    // Production refuses loopback; let only the test site through.
    const fetchPageText = urlFetcher.fetchPageText
    urlFetcher.fetchPageText = url => fetchPageText(url, {
      isBlocked: (address, family) => address !== '127.0.0.1' && urlFetcher.isBlockedAddress(address, family)
    })
  })
  after(() => site.close())
  beforeEach(() => {
    configureGateway()
    discord = installBot({ guilds: [guild], messages: MESSAGES, forums: FORUMS })
  })

  test('URL → page read → preview → register', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([
      [call('fetch_url', { url: `${site.url}/event` })],
      body => {
        const [page] = lastToolResponses(body)
        assert.match(page.response.result, /"startDate":"2026-11-07T13:00:00\+09:00"/)
        return [submit({ name: '秋の勉強会', start: '2026-11-07T13:00:00+09:00', end: '2026-11-07T17:00:00+09:00', location: '渋谷ホール', description: '参加無料' })]
      }
    ])

    const done = mentionEvent.handle(mention(channel, `<@BOT> これ登録して ${site.url}/event`))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.equal(reply.history[0].content, '内容を読み取っています…')
    const [preview] = reply.state.embeds
    assert.equal(preview.title, '秋の勉強会')
    assert.equal(preview.fields.find(f => f.name === '場所').value, '渋谷ホール')
    assert.equal(preview.fields.find(f => f.name === '参照元').value, `${site.url}/event`)
    assert.match(requests[0].body.contents[0].parts[0].text, /これ登録して/)

    await press(reply, '登録する')
    await done
    const post = discord.find(c => c.method === 'POST')
    assert.equal(post.url, '/guilds/100/scheduled-events')
    assert.deepEqual({ ...post.body, reason: undefined }, {
      name: '秋の勉強会',
      privacy_level: 2,
      scheduled_start_time: '2026-11-07T04:00:00.000Z',
      scheduled_end_time: '2026-11-07T08:00:00.000Z',
      description: '参加無料',
      entity_type: 3,
      entity_metadata: { location: '渋谷ホール' },
      reason: undefined
    })
    assert.equal(post.body.reason, `Requested by user${REQUESTER} (${REQUESTER})`)
    assert.equal(reply.state.content, 'イベントを登録しました: https://discord.com/events/100/EVENT1')
    assert.deepEqual(reply.state.components, [])
  })

  test('reply-mention reads the replied-to announcement and uses the voice channel', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([
      [call('list_channels')],
      body => {
        assert.match(lastToolResponses(body)[0].response.result, /204: ボイス（voice）/)
        return [submit({ name: '交流会', start: '2026-11-03T19:00:00+09:00', end: '2026-11-03T21:00:00+09:00', location_type: 'voice', channel_id: '204' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT>', { messageReference: { messageID: '401', channelID: '201' } }))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.match(requests[0].body.contents[0].parts[0].text, /## 依頼メッセージの返信先\n.*organizer \(3\): 【告知】11\/3/)
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '場所').value, '<#204>')
    await press(reply, '登録する')
    await done
    const post = discord.find(c => c.method === 'POST')
    assert.equal(post.body.entity_type, 2)
    assert.equal(post.body.channel_id, '204')
  })

  test('a link to a channel the requester cannot read is refused and nothing is registered', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [call('get_discord_message', { link: 'https://discord.com/channels/100/202/403' })],
      body => {
        assert.deepEqual(lastToolResponses(body)[0].response, { error: '依頼者がこのチャンネルのメッセージを閲覧できません' })
        return [submit({ found: false, reason: 'リンク先のメッセージを読めませんでした。' })]
      }
    ])
    await mentionEvent.handle(mention(channel, '<@BOT> https://discord.com/channels/100/202/403'))
    assert.equal(replies[0].state.content, '作成できませんでした: リンク先のメッセージを読めませんでした。')
    assert.equal(discord.some(c => c.method === 'POST'), false)
  })

  test('ask_user: only the requester can answer, the answer reaches the model, then cancel', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [call('ask_user', { question: 'どちらの回ですか？', options: ['昼の部', '夜の部'] })],
      body => {
        assert.deepEqual(lastToolResponses(body)[0].response, { result: '依頼者の回答: 夜の部' })
        return [submit({ name: '夜の部', start: '2026-11-03T19:00:00+09:00' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const [reply] = replies
    assert.deepEqual((await waitForButtons(reply, 'やめる')).map(b => b.label), ['昼の部', '夜の部', 'やめる'])
    assert.equal(reply.state.embeds[0].description, 'どちらの回ですか？')

    press(reply, '昼の部', OTHER_USER) // someone else: ignored
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(buttons(reply).some(b => b.label === 'やめる'), 'still waiting for the requester')

    await press(reply, '夜の部')
    await waitForButtons(reply, 'キャンセル')
    assert.ok(reply.history.some(s => s.content === '「夜の部」で続けます…'))
    await press(reply, 'キャンセル')
    await done
    assert.equal(reply.state.content, 'キャンセルしました。')
    assert.equal(discord.some(c => c.method === 'POST'), false)
  })

  test('ask_user: やめる ends the draft without asking the model again', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([[call('ask_user', { question: 'どれ？', options: ['A', 'B'] })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 何か'))
    await waitForButtons(replies[0], 'やめる')
    await press(replies[0], 'やめる')
    await done
    assert.equal(replies[0].state.content, '作成をやめました。')
    assert.equal(requests.length, 1)
  })

  test('no answer within 5 minutes cancels the draft', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    for (let i = 0; i < 50 && !buttons(replies[0] || { state: { components: [] } }).length; i++) await Promise.resolve()
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(5 * 60 * 1000)
    await done
    assert.equal(replies[0].state.content, '時間内に確認されなかったため、取りやめました。')
    assert.deepEqual(replies[0].state.components, [])
  })

  test('forum: reply-mention → list_forums → preview → post with mentions disabled', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([
      [call('list_forums')],
      body => {
        assert.equal(lastToolResponses(body)[0].response.result, '- 206: 募集\n  タグ: 募集中（1つ以上必須）\n  投稿ガイドライン: 題名に日付を入れる')
        return [call('submit_forum_post_draft', {
          found: true, channel_id: '206', title: '11/3 交流会 参加者募集', content: '@everyone 参加者募集！ 詳細は告知を見てください', tags: ['募集中', '運営']
        })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> これを募集フォーラムに立てて', { messageReference: { messageID: '401', channelID: '201' } }))
    const [reply] = replies
    await waitForButtons(reply, '投稿する')
    assert.match(requests[0].body.contents[0].parts[0].text, /これを募集フォーラムに立てて[\s\S]*返信先\n.*【告知】/)
    const [preview] = reply.state.embeds
    assert.equal(preview.title, '11/3 交流会 参加者募集')
    assert.equal(preview.fields.find(f => f.name === '投稿先').value, '<#206>')
    assert.equal(preview.fields.find(f => f.name === 'タグ').value, '募集中')

    await press(reply, '投稿する')
    await done
    const post = discord.find(c => c.method === 'POST')
    assert.equal(post.url, '/channels/206/threads')
    assert.deepEqual({ ...post.body, reason: undefined }, {
      name: '11/3 交流会 参加者募集',
      message: { content: '@everyone 参加者募集！ 詳細は告知を見てください', allowed_mentions: { parse: [] } },
      applied_tags: ['tag-open'],
      reason: undefined
    })
    assert.equal(reply.state.content, 'フォーラムに投稿しました: https://discord.com/channels/100/THREAD1')
  })

  test('forum: the requester picks the kind, and a forum they cannot post in is refused', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [call('ask_user', { question: 'どちらを作りますか？', options: ['イベントを登録', 'フォーラムに投稿'] })],
      body => {
        assert.equal(lastToolResponses(body)[0].response.result, '依頼者の回答: フォーラムに投稿')
        return [call('submit_forum_post_draft', { found: true, channel_id: '207', title: '連絡', content: '本文' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 11/3 交流会'))
    await waitForButtons(replies[0], 'フォーラムに投稿')
    await press(replies[0], 'フォーラムに投稿')
    await done
    assert.equal(replies[0].state.content, '作成できませんでした: 依頼者が <#207> に投稿する権限を持っていません。')
    assert.equal(discord.some(c => c.method === 'POST'), false)
  })

  test('a Gemini failure is reported to the requester with its cause, logged and sent to the error webhook', async (t) => {
    const logged = t.mock.method(global.logger, 'error', () => {})
    const hooked = t.mock.method(global.webhook, 'error', () => {})
    const { channel, replies } = createChannel()
    installGemini([new Error('upstream down')])
    await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    assert.equal(replies[0].state.content, '作成中にエラーが発生しました（AI の呼び出しに失敗しました（HTTP 500））。時間をおいてもう一度お試しください。')
    assert.equal(logged.mock.callCount(), 1)
    assert.match(hooked.mock.calls[0].arguments[0], /^Drafting from a mention in 100 failed: Gemini request failed: HTTP 500 upstream down/)
  })

  test('a second mention while the first is still running is turned away', async () => {
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    const first = mentionEvent.handle(mention(channel, '<@BOT> A'))
    await waitForButtons(replies[0], '登録する')
    await mentionEvent.handle(mention(channel, '<@BOT> B'))
    assert.equal(replies[1].state.content, '前の依頼を処理中です。終わってからもう一度お試しください。')
    await press(replies[0], 'キャンセル')
    await first
  })

  describe('who can use it', () => {
    test('ignores messages that do not @mention the bot', async () => {
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, 'BOT のことを話しているだけ'))
      assert.equal(replies.length, 0)
    })

    test('does nothing until the gateway is configured', async () => {
      delete process.env.CLOUDFLARE_ACCOUNT_ID
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
      assert.equal(replies.length, 0)
    })

    test('requires Manage Events from the requester', async () => {
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会', { member: createMember({ id: REQUESTER, permissions: [] }) }))
      assert.match(replies[0].state.content, /この機能を使うには「イベントの管理」権限が必要です/)
    })

    test('lets the server owner through without the permission', async () => {
      const { channel, replies } = createChannel()
      installGemini([[submit({ found: false, reason: 'なし' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会', { author: guild.ownerID, member: createMember({ id: guild.ownerID, permissions: [] }) }))
      assert.match(replies[0].state.content, /作成できませんでした: なし/)
    })

    test('refuses to register an event when the bot lacks Manage Events', async () => {
      guild.members.get('BOT').permissions = { has: () => false }
      try {
        const { channel, replies } = createChannel()
        installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
        const done = mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
        await waitForButtons(replies[0], '登録する')
        await press(replies[0], '登録する')
        await done
        assert.equal(replies[0].state.content, 'BOTに「イベントの管理」権限がないため、イベントを登録できませんでした。')
        assert.equal(discord.some(c => c.method === 'POST'), false)
      } finally {
        guild.members.get('BOT').permissions = { has: name => name === 'manageEvents' }
      }
    })

    test('asks for content when the mention is empty', async () => {
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@!BOT>'))
      assert.match(replies[0].state.content, /イベントやフォーラム投稿にしたい内容/)
    })
  })
})
