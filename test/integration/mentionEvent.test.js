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
const sharp = require('sharp')
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
// The role Discord creates for the bot, and an unrelated role.
guild.roles.set('800', { id: '800', name: 'ロボポリス', managed: true, tags: { bot_id: 'BOT' } })
guild.roles.set('801', { id: '801', name: '運営' })

const FORUMS = {
  206: { available_tags: [{ id: 'tag-open', name: '募集中' }, { id: 'tag-staff', name: '運営', moderated: true }], flags: 16, topic: '題名に日付を入れる' },
  207: { available_tags: [] }
}
const MESSAGES = {
  '201/401': { content: '【告知】11/3(火) 19:00〜21:00 #ボイス で交流会をやります', author: { id: '3', username: 'organizer' } },
  '202/403': { content: 'スタッフ会議 11/5 20時', author: { id: '4', username: 'staff' } }
}

// The channel the mention is posted in. Records every message the bot shows there.
// Replies by message ID, so REST edits (PATCH /channels/:id/messages/:id) can reach them.
const repliesByID = new Map()

function createChannel () {
  const channel = guild.channels.get('201')
  const replies = []
  channel.createMessage = async payload => {
    const reply = { id: `reply${repliesByID.size + 1}`, channel, state: { content: '', embeds: [], components: [], files: [] }, history: [] }
    repliesByID.set(reply.id, reply)
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

function mention (channel, content, { author = REQUESTER, member = createMember({ id: author }), messageReference, attachments = [] } = {}) {
  return { id: '500', content, author: { id: author, username: `user${author}` }, member, channel, messageReference, attachments }
}

function buttons (reply) {
  return (reply.state.components || []).flatMap(row => row.components).map(b => ({ label: b.label, id: b.custom_id }))
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
    // A poster is far from a banner's shape (shown whole by default); the photo is close to it
    // (cropped by default).
    const poster = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#3366cc' } }).png().toBuffer()
    const photo = await sharp({ create: { width: 1000, height: 420, channels: 3, background: '#cc6633' } }).png().toBuffer()
    site = await startServer((req, res) => {
      if (req.url === '/poster.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(poster)
      }
      if (req.url === '/photo.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(photo)
      }
      if (req.url === '/missing.png') {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><head><title>秋の勉強会</title>
        <meta property="og:image" content="${site.url}/poster.png">
        <script type="application/ld+json">{"@type":"Event","name":"秋の勉強会","startDate":"2026-11-07T13:00:00+09:00","endDate":"2026-11-07T17:00:00+09:00","location":{"name":"渋谷ホール"}}</script>
        </head><body><p>参加無料</p></body></html>`)
    })
    // Production refuses loopback; let only the test site through.
    const allowLoopback = (address, family) => address !== '127.0.0.1' && urlFetcher.isBlockedAddress(address, family)
    const { fetchPageText, fetchImage } = urlFetcher
    urlFetcher.fetchPageText = url => fetchPageText(url, { isBlocked: allowLoopback })
    urlFetcher.fetchImage = url => fetchImage(url, { isBlocked: allowLoopback })
  })
  after(() => site.close())
  beforeEach(() => {
    configureGateway()
    discord = installBot({ guilds: [guild], messages: MESSAGES, forums: FORUMS })
    // A message edit with files goes over REST; apply it to the reply like Discord would.
    const request = global.bot.requestHandler.request
    global.bot.requestHandler.request = async (method, url, auth, body, files) => {
      const edit = method === 'PATCH' && url.match(/^\/channels\/\d+\/messages\/(\w+)$/)
      if (!edit) return request(method, url, auth, body, files)
      const { attachments, ...update } = body
      repliesByID.get(edit[1]).apply({ ...update, files: (files || []).map((f, i) => ({ ...f, filename: attachments[i].filename })) })
      return {}
    }
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
    assert.deepEqual((await waitForButtons(reply, 'やめる')).map(b => b.label), ['昼の部', '夜の部', 'その他（文字で入力）', 'やめる'])
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

  test('修正する: a typed correction goes back to the model and a new preview replaces the old one', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [submit({ name: '交流会', start: '2026-11-03T19:00:00+09:00', location: '渋谷' })],
      body => {
        const answer = body.contents[body.contents.length - 1].parts[0].functionResponse
        assert.equal(answer.name, 'submit_event_draft')
        assert.match(answer.response.result, /開始は20時、場所は新宿/)
        return [submit({ name: '交流会', start: '2026-11-03T20:00:00+09:00', location: '新宿' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const [reply] = replies
    assert.deepEqual((await waitForButtons(reply, '修正する')).map(b => b.label), ['登録する', '修正する', 'キャンセル', '画像: AIで作成', '画像: なし'])
    await press(reply, '修正する')
    await waitFor(() => /直したい内容を入力してください/.test(reply.state.content), 'the correction prompt')

    // Someone else's message, and a new mention from the requester, are not the correction.
    await mentionEvent.handle(mention(channel, '関係ない話', { author: OTHER_USER, member: createMember({ id: OTHER_USER }) }))
    await mentionEvent.handle(mention(channel, '<@BOT> 別の依頼'))
    assert.equal(replies[1].state.content, '前の依頼を処理中です。終わってからもう一度お試しください。')

    await mentionEvent.handle(mention(channel, '開始は20時、場所は新宿'))
    await waitForButtons(reply, '登録する')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '場所').value, '新宿')
    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.scheduled_start_time, '2026-11-03T11:00:00.000Z')
  })

  test('修正する is offered three times, then only register or cancel', async () => {
    const { channel, replies } = createChannel()
    const draftTurn = [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]
    installGemini([draftTurn, draftTurn, draftTurn, draftTurn])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    for (let i = 0; i < 3; i++) {
      await waitForButtons(reply, '修正する')
      await press(reply, '修正する')
      await waitFor(() => /直したい内容/.test(reply.state.content), 'the correction prompt')
      await mentionEvent.handle(mention(channel, `修正${i}`))
    }
    assert.deepEqual((await waitForButtons(reply, 'キャンセル')).map(b => b.label), ['登録する', 'キャンセル', '画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.content, '修正は3回までです。')
    await press(reply, 'キャンセル')
    await done
  })

  test('ask_user: その他 lets the requester type an answer', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [call('ask_user', { question: '何時からですか？', options: ['19時', '20時'] })],
      body => {
        assert.deepEqual(lastToolResponses(body)[0].response, { result: '依頼者の回答: 21時半から' })
        return [submit({ found: false, reason: 'ok' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const [reply] = replies
    await waitForButtons(reply, 'その他（文字で入力）')
    await press(reply, 'その他（文字で入力）')
    await waitFor(() => /「何時からですか？」への答えを入力してください/.test(reply.state.content), 'the typed-answer prompt')
    await mentionEvent.handle(mention(channel, '21時半から'))
    await done
    assert.equal(reply.state.content, '作成できませんでした: ok')
  })

  test('no typed correction within 5 minutes cancels the draft', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    for (let i = 0; i < 50 && !buttons(replies[0] || { state: { components: [] } }).length; i++) await new Promise(resolve => setImmediate(resolve))
    press(replies[0], '修正する')
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(5 * 60 * 1000)
    await done
    assert.equal(replies[0].state.content, '時間内に入力がなかったため、作成を取りやめました。')
  })

  test('image: a poster from og:image is shown whole on a blurred background, and the preview shows the real result', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [call('fetch_url', { url: `${site.url}/event` })],
      body => {
        assert.match(lastToolResponses(body)[0].response.result, new RegExp(`og:image: ${site.url}/poster\\.png`))
        return [submit({ name: '秋の勉強会', start: '2026-11-07T13:00:00+09:00', location: '渋谷ホール', image_url: `${site.url}/poster.png` })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, `<@BOT> ${site.url}/event`))
    const [reply] = replies
    const labels = (await waitForButtons(reply, '登録する')).map(b => b.label)
    assert.deepEqual(labels, ['登録する', '修正する', 'キャンセル', '画像: 切り抜き', '画像: 全体表示', '画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.components.length, 2, 'image modes get their own row')
    assert.equal(reply.state.embeds[0].image.url, 'attachment://cover.jpg')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, '全体表示（800×320）')
    const preview = await sharp(reply.state.files[0].file).metadata()
    assert.deepEqual([reply.state.files[0].filename, preview.width, preview.height], ['cover.jpg', 800, 320])

    await press(reply, '登録する')
    await done
    const { image } = discord.find(c => c.method === 'POST').body
    assert.match(image, /^data:image\/jpeg;base64,/)
    // What is registered is exactly what the preview showed.
    assert.ok(Buffer.from(image.split(',')[1], 'base64').equals(reply.state.files[0].file))
  })

  test('image: a photo close to the banner shape is cropped by default; the requester can switch modes', async () => {
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_url: `${site.url}/photo.png` })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    await waitForButtons(reply, '画像: 全体表示')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, '切り抜き（800×320）')
    const cropped = reply.state.files[0].file

    await press(reply, '画像: 全体表示')
    await waitFor(() => /^全体表示/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the fit preview')
    assert.ok(!reply.state.files[0].file.equals(cropped))

    await press(reply, '画像: なし')
    await waitFor(() => reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value === 'なし', 'no image')
    assert.deepEqual(reply.state.files, [])
    assert.equal(reply.state.embeds[0].image, undefined)

    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.image, undefined)
  })

  test('image: AI makes a cover from the text and the source image, cropped to size', async () => {
    const { channel, replies } = createChannel()
    const generated = await sharp({ create: { width: 1344, height: 576, channels: 3, background: '#22aa66' } }).png().toBuffer()
    const requests = installGemini([
      [submit({ name: '秋の勉強会', description: '参加無料', start: '2026-11-07T13:00:00+09:00', image_url: `${site.url}/poster.png` })],
      [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: generated.toString('base64') } }]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 勉強会'))
    const [reply] = replies
    await waitForButtons(reply, '画像: AIで作成')
    await press(reply, '画像: AIで作成')
    await waitFor(() => /^AIで作成/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the AI preview')
    assert.ok(reply.history.some(s => s.content === 'AI で画像を作成しています…'))

    const imageCall = requests[1]
    assert.match(imageCall.url, /models\/gemini-3\.1-flash-image:generateContent$/)
    assert.deepEqual(imageCall.body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '21:9' } })
    const [prompt, reference] = imageCall.body.contents[0].parts
    assert.match(prompt.text, /"秋の勉強会"[\s\S]*参加無料[\s\S]*Base it on the attached image[\s\S]*Do not draw any text/)
    assert.equal(reference.inlineData.mimeType, 'image/jpeg')
    const meta = await sharp(reply.state.files[0].file).metadata()
    assert.deepEqual([meta.width, meta.height], [800, 320])

    await press(reply, 'キャンセル')
    await done
  })

  test('image: when AI fails, the previous image stays and the preview says why', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_url: `${site.url}/photo.png` })],
      [{ text: 'no image for you' }]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    await waitForButtons(reply, '画像: AIで作成')
    await press(reply, '画像: AIで作成')
    await waitFor(() => /AIで作成に失敗しました/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the failure note')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, '切り抜き（800×320）\nAIで作成に失敗しました: AI が画像を作れませんでした')
    await press(reply, 'キャンセル')
    await done
  })

  test('image: without a source image the AI can still make one; a failed download is explained', async () => {
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_url: `${site.url}/missing.png` })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    assert.deepEqual((await waitForButtons(reply, '登録する')).map(b => b.label).slice(3), ['画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, 'なし\n元の画像を使えませんでした: HTTP 404')
    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.image, undefined)
    assert.equal(reply.state.content, 'イベントを登録しました: https://discord.com/events/100/EVENT1')
  })

  test('forum: a forum named in the request wins, and an attached image is uploaded cropped to 16:9', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([
      // The model picks another forum; the named one must win.
      [call('submit_forum_post_draft', { found: true, channel_id: '207', title: '写真', content: '本文', tags: ['募集中'], image_url: `${site.url}/poster.png` })]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> <#206> に投稿して', {
      attachments: [{ url: `${site.url}/poster.png`, filename: 'poster.png', content_type: 'image/png' }, { url: `${site.url}/notes.txt`, filename: 'notes.txt', content_type: 'text/plain' }]
    }))
    const [reply] = replies
    await waitForButtons(reply, '投稿する')
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /## 依頼メッセージの添付画像\n- http:\/\/127\.0\.0\.1:\d+\/poster\.png\n\n/)
    assert.match(prompt, /## 投稿先に指定されたフォーラム\n206: 募集/)
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '投稿先').value, '<#206>')
    await press(reply, '投稿する')
    await done
    const post = discord.find(c => c.method === 'POST')
    assert.equal(post.url, '/channels/206/threads')
    assert.deepEqual(post.body.message.attachments, [{ id: 0, filename: 'image.jpg' }])
    assert.equal(post.files[0].name, 'files[0]')
    const meta = await sharp(post.files[0].file).metadata()
    assert.deepEqual([meta.width, meta.height], [1280, 720])
  })

  test('a Gemini failure is reported to the requester with its cause and a masked log, and sent to the error webhook', async (t) => {
    const logged = t.mock.method(global.logger, 'error', () => {})
    const hooked = t.mock.method(global.webhook, 'error', () => {})
    process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'cf-gateway-secret-token'
    const { channel, replies } = createChannel()
    // An error body that echoes secrets back: the gateway token, a Google key and the account ID.
    installGemini([new Error('bad auth Bearer cf-gateway-secret-token key AIzaSyA1234567890abcdefghijklmnopqrstuv at /v1/acct/gw')])
    await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const content = replies[0].state.content
    assert.match(content, /^作成中にエラーが発生しました（AI の呼び出しに失敗しました（HTTP 500））。時間をおいてもう一度お試しください。\n```\nError: Gemini request failed: HTTP 500 bad auth/)
    assert.match(content, /at callGemini \(.*eventDrafter\.js/)
    assert.match(content, /```$/)
    assert.ok(content.length <= 2000)
    for (const secret of ['cf-gateway-secret-token', 'AIzaSyA1234567890abcdefghijklmnopqrstuv']) {
      assert.ok(!content.includes(secret), `reply leaks ${secret}`)
      assert.ok(!hooked.mock.calls[0].arguments[0].includes(secret), `webhook leaks ${secret}`)
    }
    assert.equal(logged.mock.callCount(), 1)
    assert.match(hooked.mock.calls[0].arguments[0], /^Drafting from a mention in 100 failed: Gemini request failed: HTTP 500 bad auth/)
  })

  test('a very long error log is cut to fit in one Discord message', async (t) => {
    t.mock.method(global.logger, 'error', () => {})
    t.mock.method(global.webhook, 'error', () => {})
    const { channel, replies } = createChannel()
    installGemini([new Error('x'.repeat(5000))])
    await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const content = replies[0].state.content
    assert.ok(content.length <= 2000, `length ${content.length}`)
    assert.match(content, /…（以下省略）\n```$/)
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

    test('tells staff which settings are missing, once logs it, and stays silent for others', async (t) => {
      const warned = t.mock.method(global.logger, 'warn', () => {})
      delete process.env.CLOUDFLARE_ACCOUNT_ID
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
      assert.equal(replies[0].state.content, 'メンション機能が設定されていないため使えません（未設定: CLOUDFLARE_ACCOUNT_ID）。')
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会', { author: OTHER_USER, member: createMember({ id: OTHER_USER, permissions: [] }) }))
      assert.equal(replies.length, 1)
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
      assert.equal(warned.mock.callCount(), 1)
      assert.match(warned.mock.calls[0].arguments[0], /Mention drafting is disabled: CLOUDFLARE_ACCOUNT_ID not set/)
    })

    test('treats a mention of the bot\'s own role as a mention of the bot', async () => {
      const { channel, replies } = createChannel()
      const requests = installGemini([[submit({ found: false, reason: 'なし' })]])
      await mentionEvent.handle(mention(channel, '<@&800> 交流会 <@&801> と相談'))
      assert.equal(replies[0].state.content, '作成できませんでした: なし')
      // The bot's role is stripped from the request; other role mentions are kept as written.
      assert.match(requests[0].body.contents[0].parts[0].text, /## 依頼メッセージ\n交流会 <@&801> と相談/)
    })

    test('ignores a mention of some other role', async () => {
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@&801> 交流会'))
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
