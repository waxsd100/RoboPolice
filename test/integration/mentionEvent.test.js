// Integration: a mention runs through the real mentionEvent -> eventDrafter -> eventTools ->
// urlFetcher chain and the real interactionCreate button handling. Only Discord's API and Gemini
// are faked; web pages come from a local HTTP server.
const { test, describe, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
// Load first: it sets the environment the bot modules read when they are required.
const {
  createGuild, createMember, installBot, installYouTubeStore, installQuotaStore, configureGateway, installGemini, call, submit, lastToolResponses, startServer
} = require('../helpers/fakes')
const Eris = require('eris')
const sharp = require('sharp')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const interactionCreate = require('../../src/bot/events/interactionCreate')
const mentionEvent = require('../../src/bot/modules/mentionEvent')
const { EDIT_HINT } = require('../../src/bot/modules/postedEdit')

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

function mention (channel, content, { author = REQUESTER, member = createMember({ id: author }), messageReference, referencedMessage, attachments = [] } = {}) {
  return { id: '500', content, author: { id: author, username: `user${author}` }, member, channel, messageReference, referencedMessage, attachments }
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
  let quota
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
    installYouTubeStore()
    quota = installQuotaStore()
    discord = installBot({ guilds: [guild], messages: MESSAGES, forums: FORUMS })
    // A message edit with files goes over REST; apply it to the reply like Discord would.
    const request = global.bot.requestHandler.request
    global.bot.requestHandler.request = async (method, url, auth, body, files) => {
      const edit = method === 'PATCH' && url.match(/^\/channels\/\d+\/messages\/(\w+)$/)
      if (!edit || !repliesByID.has(edit[1])) return request(method, url, auth, body, files)
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
    assert.equal(reply.state.content, `イベントを登録しました: https://discord.com/events/100/EVENT1\n${EDIT_HINT}`)
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
    assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\nリンク先のメッセージを読めませんでした。')
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
    assert.equal(reply.state.content, `フォーラムに投稿しました: https://discord.com/channels/100/THREAD1\n${EDIT_HINT}`)
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
    assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\n依頼者が <#207> に投稿する権限を持っていません。')
    assert.equal(discord.some(c => c.method === 'POST'), false)
  })

  test('内容を修正: a typed correction goes back to the model and a new preview replaces the old one', async () => {
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
    assert.deepEqual((await waitForButtons(reply, '内容を修正')).map(b => b.label), ['登録する', '内容を修正', '画像を指示で変更', 'キャンセル', '画像: AIで作成', '画像: なし'])
    await press(reply, '内容を修正')
    await waitFor(() => /で直したいことを入力してください/.test(reply.state.content), 'the correction prompt')

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

  test('内容を修正 is offered three times, then only register or cancel', async () => {
    const { channel, replies } = createChannel()
    const draftTurn = [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]
    installGemini([draftTurn, draftTurn, draftTurn, draftTurn])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    for (let i = 0; i < 3; i++) {
      await waitForButtons(reply, '内容を修正')
      await press(reply, '内容を修正')
      await waitFor(() => /で直したいことを/.test(reply.state.content), 'the correction prompt')
      await mentionEvent.handle(mention(channel, `修正${i}`))
    }
    assert.deepEqual((await waitForButtons(reply, 'キャンセル')).map(b => b.label), ['登録する', '画像を指示で変更', 'キャンセル', '画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.content, '内容の修正は3回までです。')
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
    assert.equal(reply.state.content, '⚠️ **作成できませんでした**\nok')
  })

  test('no typed correction within 5 minutes cancels the draft', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    for (let i = 0; i < 50 && !buttons(replies[0] || { state: { components: [] } }).length; i++) await new Promise(resolve => setImmediate(resolve))
    press(replies[0], '内容を修正')
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
        return [submit({ name: '秋の勉強会', start: '2026-11-07T13:00:00+09:00', location: '渋谷ホール', image_urls: [`${site.url}/poster.png`] })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, `<@BOT> ${site.url}/event`))
    const [reply] = replies
    const labels = (await waitForButtons(reply, '登録する')).map(b => b.label)
    assert.deepEqual(labels, ['登録する', '内容を修正', '画像を指示で変更', 'キャンセル', '画像: 切り抜き', '画像: 全体表示', '画像: AIで作成', '画像: なし'])
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
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`] })]])
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

  test('image: several candidates are proposed side by side, and the chosen one is registered', async () => {
    const { channel, replies } = createChannel()
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`, `${site.url}/poster.png`, `${site.url}/missing.png`] })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    const labels = (await waitForButtons(reply, '画像2')).map(b => b.label)
    assert.deepEqual(labels, ['登録する', '内容を修正', '画像を指示で変更', 'キャンセル', '画像1', '画像2', '画像: 切り抜き', '画像: 全体表示', '画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.components.length, 3, 'candidates and modes get rows of their own')
    assert.equal(reply.state.embeds[1].title, '画像の候補')
    assert.equal(reply.state.embeds[1].image.url, 'attachment://candidates.jpg')
    assert.deepEqual(reply.state.files.map(f => f.filename), ['cover.jpg', 'candidates.jpg'])
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value,
      '画像1・切り抜き（800×320）\n候補 2 枚（下の一覧で 画像1=左上、画像2=右上、黄色の枠が選択中）\n使えなかった画像: HTTP 404')
    const firstSheet = reply.state.files[1].file

    await press(reply, '画像2')
    await waitFor(() => /^画像2・全体表示/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the second candidate')
    assert.ok(!reply.state.files[1].file.equals(firstSheet), 'the frame moves to the chosen candidate')

    await press(reply, '登録する')
    await done
    const { image } = discord.find(c => c.method === 'POST').body
    assert.ok(Buffer.from(image.split(',')[1], 'base64').equals(reply.state.files[0].file))
  })

  test('image: AI makes a cover from the text and the source image, cropped to size', async () => {
    const { channel, replies } = createChannel()
    const generated = await sharp({ create: { width: 1344, height: 576, channels: 3, background: '#22aa66' } }).png().toBuffer()
    const requests = installGemini([
      [submit({ name: '秋の勉強会', description: '参加無料', start: '2026-11-07T13:00:00+09:00', image_urls: [`${site.url}/poster.png`] })],
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

  test('image: 画像を指示で変更 edits the image shown with the requester\'s words, and an attached image replaces it', async () => {
    const { channel, replies } = createChannel()
    const edited = await sharp({ create: { width: 1344, height: 576, channels: 3, background: '#112244' } }).png().toBuffer()
    const requests = installGemini([
      [submit({ name: '秋の勉強会', start: '2026-11-07T13:00:00+09:00', image_urls: [`${site.url}/photo.png`] })],
      [{ inlineData: { mimeType: 'image/png', data: edited.toString('base64') } }]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 勉強会'))
    const [reply] = replies
    await waitForButtons(reply, '画像を指示で変更')
    const cropped = reply.state.files[0].file
    await press(reply, '画像を指示で変更')
    await waitFor(() => /画像をどう変えるか入力してください/.test(reply.state.content), 'the image prompt')
    await mentionEvent.handle(mention(channel, '背景を夜空にして'))
    await waitFor(() => /^AIで編集/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the edited preview')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, 'AIで編集（800×320）\n指示: 背景を夜空にして')
    assert.ok(reply.history.some(h => h.content === '画像を変更しています…'))

    const [prompt, reference] = requests[1].body.contents[0].parts
    assert.match(prompt.text, /^Edit the attached image[\s\S]*Instruction \(from the requester, may be in Japanese\): 背景を夜空にして/)
    assert.ok(Buffer.from(reference.inlineData.data, 'base64').equals(cropped), 'the image shown is what gets edited')
    assert.ok(buttons(reply).some(b => b.label === '画像: AIで編集'))

    // A reply with an image attached and no text replaces the image.
    await press(reply, '画像を指示で変更')
    await waitFor(() => /画像をどう変えるか/.test(reply.state.content), 'the image prompt again')
    await mentionEvent.handle(mention(channel, '', { attachments: [{ url: `${site.url}/poster.png`, filename: 'poster.png', content_type: 'image/png' }] }))
    await waitFor(() => /^画像2・全体表示/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the replaced image')
    assert.equal(requests.length, 2, 'replacing needs no AI')

    await press(reply, '登録する')
    await done
    const { image } = discord.find(c => c.method === 'POST').body
    assert.ok(Buffer.from(image.split(',')[1], 'base64').equals(reply.state.files[0].file))
  })

  test('image: an instruction about the image in the request itself is applied to the first preview', async () => {
    const { channel, replies } = createChannel()
    const edited = await sharp({ create: { width: 1344, height: 576, channels: 3, background: '#331100' } }).png().toBuffer()
    const requests = installGemini([
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`], image_instruction: 'もっと明るく' })],
      [{ inlineData: { mimeType: 'image/png', data: edited.toString('base64') } }]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A 画像はもっと明るくして'))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, 'AIで編集（800×320）\n指示: もっと明るく')
    assert.match(requests[1].body.contents[0].parts[0].text, /Instruction[^\n]*: もっと明るく/)
    await press(reply, 'キャンセル')
    await done
  })

  test('image: when AI fails, the previous image stays and the preview says why', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`] })],
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
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/missing.png`] })]])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    assert.deepEqual((await waitForButtons(reply, '登録する')).map(b => b.label).slice(4), ['画像: AIで作成', '画像: なし'])
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '画像').value, 'なし\n使えなかった画像: HTTP 404')
    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.image, undefined)
    assert.equal(reply.state.content, `イベントを登録しました: https://discord.com/events/100/EVENT1\n${EDIT_HINT}`)
  })

  test('forum: a forum named in the request wins, and an attached image is uploaded cropped to 16:9', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([
      // The model picks another forum; the named one must win.
      [call('submit_forum_post_draft', { found: true, channel_id: '207', title: '写真', content: '本文', tags: ['募集中'], image_urls: [`${site.url}/poster.png`] })]
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

  test('every request carries a fresh server profile and the request channel ID', async () => {
    const { channel, replies } = createChannel()
    const requests = installGemini([[submit({ found: false, reason: 'x' })]])
    await mentionEvent.handle(mention(channel, '<@BOT> このチャンネルの内容でイベントを作って'))
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /依頼されたチャンネル: #general（ID: 201）/)
    assert.match(prompt, /## このサーバーの情報（最新）\nサーバー名: テストサーバー/)
    assert.match(prompt, /- 201: #general（text） ← 依頼されたチャンネル/)
    assert.doesNotMatch(prompt, /#staff/, 'channels the requester cannot see are left out')
    assert.match(prompt, /### YouTube\n設定なし/)
    assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\nx')
  })

  test('YouTube: the stored channel is searchable and an upcoming stream becomes an event', async () => {
    installYouTubeStore({
      100: {
        channel: { channel_ref: '@nobaman', title: 'のばまんch', url: 'https://www.youtube.com/channel/UCx', synced_at: new Date('2026-10-29T12:00:00Z') },
        videos: [
          { title: '1周年記念配信', description: 'みんなでお祝い', live_status: 'upcoming', scheduled_start: new Date('2026-11-03T11:00:00Z'), published_at: new Date('2026-10-28T00:00:00Z'), url: 'https://www.youtube.com/watch?v=v2' },
          { title: '雑談', description: '', live_status: 'none', published_at: new Date('2026-10-20T00:00:00Z'), url: 'https://www.youtube.com/watch?v=v1' }
        ]
      }
    })
    const { channel, replies } = createChannel()
    const requests = installGemini([
      [call('search_youtube', { query: '記念' })],
      body => {
        const result = lastToolResponses(body)[0].response.result
        assert.match(result, /\[配信予定 2026-11-03T11:00:00\.000Z\] 1周年記念配信/)
        assert.doesNotMatch(result, /雑談/)
        return [submit({ name: '1周年記念配信', start: '2026-11-03T20:00:00+09:00', location: 'https://www.youtube.com/watch?v=v2' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 次の記念配信をイベントにして'))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.match(requests[0].body.contents[0].parts[0].text, /### YouTube\nのばまんch（動画 2 件を保存/)
    await press(reply, '登録する')
    await done
    const post = discord.find(c => c.method === 'POST')
    assert.equal(post.body.entity_metadata.location, 'https://www.youtube.com/watch?v=v2')
  })

  test('channel history: "このチャンネルの内容で" reads the stored messages of the request channel', async (t) => {
    const read = require('../../src/db/interfaces/postgres/read')
    t.mock.method(read, 'getChannelHistory', async channelID => channelID === '201'
      ? [
          { author_id: '3', content: '決定！ 11/8(土) 14時から渋谷で勉強会やります', ts: new Date('2026-10-28T10:00:00Z') },
          { author_id: '2', content: '勉強会いつにする？', ts: new Date('2026-10-25T10:00:00Z') }
        ]
      : [])
    const { channel, replies } = createChannel()
    const requests = installGemini([
      body => {
        assert.match(body.contents[0].parts[0].text, /依頼されたチャンネル: #general（ID: 201）/)
        return [call('search_channel_history', { channel_id: '201', query: '勉強会' })]
      },
      body => {
        const result = lastToolResponses(body)[0].response.result
        assert.match(result, /保存済みメッセージ 2 件.*のうち「勉強会」を含む 2 件、古い順:\n\[2026-10-25T10:00:00\.000Z\] .*勉強会いつにする？\n\[2026-10-28T10:00:00\.000Z\] .*11\/8\(土\) 14時から渋谷/)
        return [submit({ name: '勉強会', start: '2026-11-08T14:00:00+09:00', location: '渋谷' })]
      }
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> このチャンネルの内容でイベントを作って'))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.match(requests[0].body.systemInstruction.parts[0].text, /search_channel_history/)
    assert.equal(reply.state.embeds[0].fields.find(f => f.name === '参照元').value, '<#201>')
    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.scheduled_start_time, '2026-11-08T05:00:00.000Z')
  })

  test('YouTube: a linked video is summarized once, then the stored summary is reused', async () => {
    const youtube = installYouTubeStore()
    const turns = (summaryCall) => [
      [call('summarize_youtube_video', { url: 'https://youtu.be/dQw4w9WgXcQ' })],
      ...(summaryCall ? [summaryCall] : []),
      body => {
        assert.match(lastToolResponses(body)[0].response.result, /11\/15 19時から 1 周年オフ会/)
        return [submit({ name: '1周年オフ会', start: '2026-11-15T19:00:00+09:00', location: '新宿' })]
      }
    ]

    const first = createChannel()
    const requests = installGemini(turns(body => {
      assert.deepEqual(body.contents[0].parts[0], { fileData: { fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } })
      return [{ text: '・11/15 19時から 1 周年オフ会を新宿で開催と告知' }]
    }))
    const done = mentionEvent.handle(mention(first.channel, '<@BOT> この動画で告知してたオフ会をイベントにして https://youtu.be/dQw4w9WgXcQ'))
    await waitForButtons(first.replies[0], '登録する')
    assert.equal(requests.length, 3, 'drafting turn, video summary, drafting turn')
    assert.match(first.replies[0].state.embeds[0].fields.find(f => f.name === '参照元').value, /https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ/)
    await press(first.replies[0], 'キャンセル')
    await done
    assert.deepEqual(youtube.writes, [{ saveSummary: ['100', 'dQw4w9WgXcQ'] }])

    // Second time: no video call, the stored summary answers.
    const second = createChannel()
    const again = installGemini(turns(null))
    const done2 = mentionEvent.handle(mention(second.channel, '<@BOT> https://youtu.be/dQw4w9WgXcQ のオフ会'))
    await waitForButtons(second.replies[0], '登録する')
    assert.equal(again.length, 2)
    assert.ok(again.every(r => !JSON.stringify(r.body).includes('fileData')))
    await press(second.replies[0], 'キャンセル')
    await done2
  })

  test('rate limit: a 429 is waited out, the requester is told, and the request count is logged', async (t) => {
    const { retryTimer } = require('../../src/bot/modules/eventDrafter')
    t.mock.method(retryTimer, 'sleep', async () => {})
    const logged = t.mock.method(global.logger, 'info', () => {})
    const { channel, replies } = createChannel()
    const turns = [
      { status: 429 },
      [call('list_channels')],
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]
    ]
    let i = 0
    global.fetch = async () => {
      const turn = turns[i++]
      if (turn.status) return { ok: false, status: 429, headers: { get: () => '3' }, text: async () => '{"name":"AiGatewayError","internalCode":2003}' }
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: turn } }] }) }
    }
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    await waitForButtons(reply, '登録する')
    assert.ok(reply.history.some(s => s.content === 'AI が混み合っているため、3 秒待ってから再試行します…'))
    await press(reply, 'キャンセル')
    await done
    const line = logged.mock.calls.map(c => c.arguments[0]).find(m => /^Mention drafting in 100/.test(m))
    assert.equal(line, 'Mention drafting in 100: 3 Gemini request(s), 1 retried after HTTP 429')
  })

  test('the draft still works when the server profile cannot be built', async (t) => {
    const warned = t.mock.method(global.logger, 'warn', () => {})
    require('../../src/db/interfaces/postgres/youtube').getKnowledge = async () => { throw new Error('db down') }
    const original = guild.channels.values
    guild.channels.values = () => { throw new Error('cache broken') }
    try {
      const { channel, replies } = createChannel()
      const requests = installGemini([[submit({ found: false, reason: 'x' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
      assert.doesNotMatch(requests[0].body.contents[0].parts[0].text, /このサーバーの情報/)
      assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\nx')
      assert.match(warned.mock.calls[0].arguments[0], /Could not describe server 100: cache broken/)
    } finally {
      guild.channels.values = original
    }
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
    assert.match(content, /^⚠️ エラーが発生しました（AI の呼び出しに失敗しました（HTTP 500））。時間をおいてもう一度お試しください。\n```\nError: Gemini request failed: HTTP 500 bad auth/)
    assert.match(content, /at (async )?callGemini \(.*eventDrafter\.js/)
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

  test('内容を修正 changes the text only: the chosen image stays, and new candidates are only offered', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`, `${site.url}/poster.png`] })],
      [submit({ name: 'B', start: '2026-11-03T19:00:00+09:00', image_urls: [`${site.url}/photo.png`, `${site.url}/missing.png`] })]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> A'))
    const [reply] = replies
    await waitForButtons(reply, '画像2')
    await press(reply, '画像2')
    await waitFor(() => /^画像2・全体表示/.test(reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value), 'the second candidate')
    const chosen = reply.state.files[0].file

    await press(reply, '内容を修正')
    await waitFor(() => /で直したいことを/.test(reply.state.content), 'the correction prompt')
    await mentionEvent.handle(mention(channel, '名前はB'))
    await waitFor(() => reply.state.embeds[0]?.title === 'B', 'the corrected preview')
    assert.match(reply.state.embeds[0].fields.find(f => f.name === '画像').value, /^画像2・全体表示（800×320）\n/)
    assert.ok(reply.state.files[0].file.equals(chosen))

    await press(reply, '登録する')
    await done
    const { image } = discord.find(c => c.method === 'POST').body
    assert.ok(Buffer.from(image.split(',')[1], 'base64').equals(chosen))
  })

  test('chat: talk that is not a request gets a plain reply, without pings and without buttons', async () => {
    const { channel, replies } = createChannel()
    installGemini([[call('submit_chat_reply', { text: 'こんにちは！ <@&801> 今日も配信楽しみ！' })]])
    await mentionEvent.handle(mention(channel, '<@BOT> こんにちは'))
    assert.equal(replies[0].state.content, 'こんにちは！ <@&801> 今日も配信楽しみ！')
    assert.deepEqual(replies[0].state.allowedMentions, { everyone: false, roles: false, users: false })
    assert.deepEqual(replies[0].state.components, [])
    assert.doesNotMatch(replies[0].state.content, /⚠️/)
  })

  test('chat: server emojis are offered to the model, and :name: becomes the emoji', async () => {
    guild.emojis = [{ id: '950', name: 'nobaman_wave' }]
    try {
      const { channel, replies } = createChannel()
      installGemini([body => {
        assert.match(body.contents[0].parts[0].text, /### サーバー絵文字（返事で使うときは、この書き方のまま書く）\n<:nobaman_wave:950>/)
        assert.match(body.systemInstruction.parts[0].text, /サーバー絵文字」があれば、話の流れに合うときに使って[\s\S]*` や ``` で囲まないで/)
        return [call('submit_chat_reply', { text: 'こんばんは :nobaman_wave:' })]
      }])
      await mentionEvent.handle(mention(channel, '<@BOT> こんばんは'))
      assert.equal(replies[0].state.content, 'こんばんは <:nobaman_wave:950>')
    } finally {
      delete guild.emojis
    }
  })

  test('chat: another server\'s emoji in the request is shown to the model as an image, for that request only', async (t) => {
    t.mock.method(urlFetcher, 'fetchImage', async url => ({ buffer: Buffer.from(url), contentType: 'image/png' }))
    const { channel, replies } = createChannel()
    const requests = installGemini([body => {
      const parts = body.contents[0].parts
      assert.match(parts[1].text, /ほかのサーバーの絵文字[\s\S]*:yotsu_dance:[\s\S]*返事には使わないで/)
      assert.equal(parts[2].text, ':yotsu_dance:')
      assert.deepEqual(parts[3], { inlineData: { mimeType: 'image/png', data: Buffer.from('https://cdn.discordapp.com/emojis/123456789012345678.png?size=96').toString('base64') } })
      return [call('submit_chat_reply', { text: '楽しそうに踊ってるね！' })]
    }])
    await mentionEvent.handle(mention(channel, '<@BOT> これ見て <a:yotsu_dance:123456789012345678>'))
    assert.equal(requests.length, 1)
    assert.equal(replies[0].state.content, '楽しそうに踊ってるね！')
  })

  test('chat: a combined emoji, even of the server\'s own emojis, is shown stitched into one picture', async (t) => {
    const sharp = require('sharp')
    const tile = await sharp({ create: { width: 96, height: 96, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer()
    t.mock.method(urlFetcher, 'fetchImage', async () => ({ buffer: tile, contentType: 'image/png' }))
    const { channel, replies } = createChannel()
    channel.guild.emojis = [{ id: '111111111111111111', name: 'big1' }, { id: '222222222222222222', name: 'big2' }]
    try {
      installGemini([body => {
        const parts = body.contents[0].parts
        assert.match(parts[1].text, /連結絵文字: 複数の絵文字を並べて1枚の絵にしたもの/)
        assert.equal(parts[2].text, '連結絵文字 :big1::big2:')
        assert.equal(parts[3].inlineData.mimeType, 'image/png')
        assert.equal(parts.length, 4, 'the tiles are not shown one by one')
        return [call('submit_chat_reply', { text: '大きいよつろんだ！' })]
      }])
      await mentionEvent.handle(mention(channel, '<@BOT> <:big1:111111111111111111><:big2:222222222222222222>'))
      assert.equal(replies[0].state.content, '大きいよつろんだ！')
    } finally {
      delete channel.guild.emojis
    }
  })

  test('chat: replying to the bot\'s answer continues the conversation', async () => {
    MESSAGES['201/610'] = { content: '<@BOT> おすすめの動画ある？', author: { id: REQUESTER, username: `user${REQUESTER}` } }
    MESSAGES['201/611'] = { content: 'マイクラ実況の最新回がおすすめ！', author: { id: 'BOT', username: 'bot' }, messageReference: { messageID: '610', channelID: '201' } }
    try {
      const { channel, replies } = createChannel()
      const requests = installGemini([body => {
        assert.match(body.contents[0].parts[0].text, /## 依頼メッセージの返信先（返信をたどった会話[^\n]*\n.*user1 \(1\)（依頼者）: <@BOT> おすすめの動画ある？\n.*あなた（BOT）: マイクラ実況の最新回がおすすめ！\n\n## /)
        return [call('submit_chat_reply', { text: '続きは来週の配信でやる予定はまだ決まってないよ！' })]
      }])
      await mentionEvent.handle(mention(channel, '<@BOT> それの続きは？', { messageReference: { messageID: '611', channelID: '201' } }))
      assert.equal(requests.length, 1)
      assert.equal(replies[0].state.content, '続きは来週の配信でやる予定はまだ決まってないよ！')
    } finally {
      delete MESSAGES['201/610']
      delete MESSAGES['201/611']
    }
  })

  test('chat: a Discord reply to the bot\'s answer, without the mention, is answered too', async () => {
    MESSAGES['201/610'] = { content: '<@BOT> おすすめの動画ある？', author: { id: REQUESTER, username: `user${REQUESTER}` } }
    const answer = { id: '611', content: 'マイクラ実況の最新回がおすすめ！', author: { id: 'BOT', username: 'bot' }, messageReference: { messageID: '610', channelID: '201' } }
    MESSAGES['201/611'] = answer
    try {
      const { channel, replies } = createChannel()
      const requests = installGemini([[call('submit_chat_reply', { text: 'まだ決まってないよ！' })]])
      await mentionEvent.handle(mention(channel, 'それの続きは？', { messageReference: { messageID: '611', channelID: '201' }, referencedMessage: answer }))
      assert.equal(requests.length, 1)
      assert.match(requests[0].body.contents[0].parts[0].text, /それの続きは？/)
      assert.equal(replies[0].state.content, 'まだ決まってないよ！')

      // Not a reply to the bot's answer: a log or post of the bot (not a reply), or someone else's message.
      const log = { id: '612', content: 'メッセージが削除されました', author: { id: 'BOT', username: 'bot' }, webhookID: 'W1', messageReference: { messageID: '1' } }
      const post = { id: '613', content: 'お知らせ', author: { id: 'BOT', username: 'bot' } }
      const other = { id: '614', content: 'やあ', author: { id: '2', username: 'user2' }, messageReference: { messageID: '1' } }
      for (const ref of [log, post, other]) {
        await mentionEvent.handle(mention(channel, 'ふーん', { messageReference: { messageID: ref.id, channelID: '201' }, referencedMessage: ref }))
      }
      assert.equal(requests.length, 1)
      assert.equal(replies.length, 1)
    } finally {
      delete MESSAGES['201/610']
      delete MESSAGES['201/611']
    }
  })

  test('chat: a question asked in place of a correction is answered above the same draft', async () => {
    const { channel, replies } = createChannel()
    installGemini([
      [submit({ name: '交流会', start: '2026-11-03T19:00:00+09:00' })],
      [call('submit_chat_reply', { text: '終了時刻は書かれていなかったので1時間にしています' })]
    ])
    const done = mentionEvent.handle(mention(channel, '<@BOT> 交流会'))
    const [reply] = replies
    await waitForButtons(reply, '内容を修正')
    await press(reply, '内容を修正')
    await waitFor(() => /で直したいことを/.test(reply.state.content), 'the correction prompt')
    await mentionEvent.handle(mention(channel, '終わりの時間はどうなってる？'))
    await waitForButtons(reply, '登録する')
    assert.equal(reply.state.content, '終了時刻は書かれていなかったので1時間にしています')
    assert.equal(reply.state.embeds[0].title, '交流会')
    await press(reply, '登録する')
    await done
    assert.equal(discord.find(c => c.method === 'POST').body.name, '交流会')
  })

  test('outside the owner\'s server, each user gets 5 mentions a day, the server 30', async () => {
    const { channel, replies } = createChannel()
    const day = require('../../src/bot/utils/mentionQuota').today(new Date())
    quota.set(`mention-quota:100:${REQUESTER}:${day}`, 5)
    installGemini([])
    await mentionEvent.handle(mention(channel, '<@BOT> こんにちは'))
    assert.equal(replies[0].state.content, '今日の利用回数の上限（1日5回）に達しました。明日（日本時間の0時以降）またお試しください。')
    quota.set(`mention-quota-guild:100:${day}`, 30)
    await mentionEvent.handle(mention(channel, '<@BOT> こんにちは', { author: OTHER_USER, member: createMember({ id: OTHER_USER }) }))
    assert.equal(replies[1].state.content, 'このサーバーの今日の利用回数の上限（1日30回）に達しました。明日（日本時間の0時以降）またお試しください。')
    quota.delete(`mention-quota-guild:100:${day}`)
  })

  test('in the owner\'s server, each user gets 30 mentions a day', async () => {
    process.env.OWNER_GUILD_IDS = '100'
    const { channel, replies } = createChannel()
    for (let i = 0; i < 30; i++) quota.set(`mention-quota:${REQUESTER}:${require('../../src/bot/utils/mentionQuota').today(new Date())}`, i + 1)
    installGemini([])
    await mentionEvent.handle(mention(channel, '<@BOT> こんにちは'))
    delete process.env.OWNER_GUILD_IDS
    assert.equal(replies[0].state.content, '今日の利用回数の上限（1日30回）に達しました。明日（日本時間の0時以降）またお試しください。')
    process.env.OWNER_GUILD_IDS = '100'
    installGemini([[call('submit_chat_reply', { text: 'やあ' })]])
    await mentionEvent.handle(mention(channel, '<@BOT> こんにちは', { author: OTHER_USER, member: createMember({ id: OTHER_USER }) }))
    delete process.env.OWNER_GUILD_IDS
    assert.equal(replies[1].state.content, 'やあ')
  })

  describe('changing what the bot made', () => {
    const EVENT = {
      id: '901',
      creator_id: 'BOT',
      status: 1,
      name: '交流会',
      description: '誰でも参加できます',
      scheduled_start_time: '2026-11-03T10:00:00.000Z',
      scheduled_end_time: '2026-11-03T11:00:00.000Z',
      entity_type: 3,
      entity_metadata: { location: '渋谷' },
      image: null
    }
    let saved
    let eventChanges // fields of EVENT a test overrides
    beforeEach(() => {
      saved = { ...MESSAGES }
      eventChanges = {}
      MESSAGES['201/600'] = { content: `イベントを登録しました: https://discord.com/events/100/901\n${EDIT_HINT}`, author: { id: 'BOT', username: 'bot' } }
      MESSAGES['700/700'] = {
        content: '参加したい人は書き込んでください',
        author: { id: 'BOT', username: 'bot' },
        attachments: [{ url: `${site.url}/photo.png`, filename: 'image.jpg', content_type: 'image/jpeg' }]
      }
      FORUMS['700'] = { type: 11, guild_id: '100', parent_id: '206', name: '11/3 交流会', applied_tags: ['tag-open'] }
      const request = global.bot.requestHandler.request
      global.bot.requestHandler.request = async (method, url, auth, body, files) => {
        if (method === 'GET' && url === '/guilds/100/scheduled-events/901') {
          discord.push({ method, url })
          return { ...EVENT, ...eventChanges }
        }
        return request(method, url, auth, body, files)
      }
    })
    afterEach(() => {
      for (const key of Object.keys(MESSAGES)) if (!(key in saved)) delete MESSAGES[key]
      delete FORUMS['700']
    })

    test('replying to "イベントを登録しました" changes only what is asked, and the image is left alone', async () => {
      const { channel, replies } = createChannel()
      const requests = installGemini([body => {
        const prompt = body.contents[0].parts[0].text
        assert.match(prompt, /## 修正するイベント（BOT が作成済み）/)
        assert.match(prompt, /"name": "交流会"[\s\S]*"start": "2026-11-03T10:00:00.000Z"[\s\S]*"location": "渋谷"/)
        assert.doesNotMatch(prompt, /## 依頼メッセージの返信先/)
        return [submit({ name: '交流会', description: '誰でも参加できます', start: '2026-11-03T20:00:00+09:00', end: '2026-11-03T21:00:00+09:00', location: '渋谷' })]
      }])
      const done = mentionEvent.handle(mention(channel, '<@BOT> 開始を20時にして', { messageReference: { messageID: '600', channelID: '201' } }))
      const [reply] = replies
      assert.deepEqual((await waitForButtons(reply, '更新する')).map(b => b.label), ['更新する', '内容を修正', '画像を指示で変更', 'キャンセル', '画像: AIで作成', '画像: なし'])
      const declared = requests[0].body.tools[0].functionDeclarations.map(d => d.name)
      assert.ok(declared.includes('submit_event_draft') && !declared.includes('submit_forum_post_draft'), 'only the same kind can be submitted')
      assert.equal(reply.state.embeds[0].fields.find(f => f.name === '変更する項目').value, '開始、終了')
      assert.match(reply.state.embeds[0].footer.text, /「更新する」を押してください/)

      await press(reply, '更新する')
      await done
      assert.equal(discord.filter(c => c.method === 'POST').length, 0, 'nothing new is created')
      const patch = discord.find(c => c.method === 'PATCH')
      assert.equal(patch.url, '/guilds/100/scheduled-events/901')
      assert.deepEqual(patch.body, {
        name: '交流会',
        description: '誰でも参加できます',
        scheduled_start_time: '2026-11-03T11:00:00.000Z',
        scheduled_end_time: '2026-11-03T12:00:00.000Z',
        entity_type: 3,
        channel_id: null,
        entity_metadata: { location: '渋谷' },
        reason: `Requested by user${REQUESTER} (${REQUESTER})`
      })
      assert.equal(reply.state.content, `イベントを更新しました: https://discord.com/events/100/901\n${EDIT_HINT}`)
    })

    test('replying to a forum post changes it in place; its forum stays and its image can be removed', async () => {
      const { channel, replies } = createChannel()
      installGemini([body => {
        assert.match(body.contents[0].parts[0].text, /## 修正するフォーラム投稿[\s\S]*"title": "11\/3 交流会"[\s\S]*"tags": \[\n\s+"募集中"/)
        // The model names another forum; a post can't move, so its own forum is kept.
        return [call('submit_forum_post_draft', { found: true, channel_id: '207', title: '11/3 交流会【締切】', content: '参加したい人は書き込んでください', tags: ['募集中'] })]
      }])
      const done = mentionEvent.handle(mention(channel, '<@BOT> 題名に締切って入れて', { messageReference: { messageID: '700', channelID: '700' } }))
      const [reply] = replies
      await waitForButtons(reply, '更新する')
      assert.deepEqual(buttons(reply).map(b => b.label).slice(4), ['画像: 今の画像のまま', '画像: AIで作成', '画像: なし'])
      const fields = reply.state.embeds[0].fields
      assert.equal(fields.find(f => f.name === '投稿先').value, '<#206>')
      assert.equal(fields.find(f => f.name === '変更する項目').value, '題名')
      assert.equal(fields.find(f => f.name === '画像').value, '今の画像のまま')
      assert.ok(reply.state.files[0].file.length > 0, 'the present image is shown')

      await press(reply, '画像: なし')
      await waitFor(() => reply.state.embeds[0]?.fields.find(f => f.name === '画像')?.value === 'なし', 'no image')
      await press(reply, '更新する')
      await done
      const patches = discord.filter(c => c.method === 'PATCH')
      assert.deepEqual(patches.map(c => c.url), ['/channels/700', '/channels/700/messages/700'])
      assert.deepEqual(patches[0].body, { name: '11/3 交流会【締切】', applied_tags: ['tag-open'], reason: `Requested by user${REQUESTER} (${REQUESTER})` })
      assert.deepEqual(patches[1].body, { content: '参加したい人は書き込んでください', allowed_mentions: { parse: [] }, attachments: [] })
      assert.equal(reply.state.content, `フォーラムの投稿を更新しました: https://discord.com/channels/100/700\n${EDIT_HINT}`)
    })

    test('an instruction about the image edits the posted image, and the update uploads it', async () => {
      const { channel, replies } = createChannel()
      const edited = await sharp({ create: { width: 1344, height: 756, channels: 3, background: '#224411' } }).png().toBuffer()
      const requests = installGemini([
        [call('submit_forum_post_draft', { found: true, channel_id: '206', title: '11/3 交流会', content: '参加したい人は書き込んでください', tags: ['募集中'], image_instruction: '画像を夕焼けにして' })],
        [{ inlineData: { mimeType: 'image/png', data: edited.toString('base64') } }]
      ])
      const done = mentionEvent.handle(mention(channel, '<@BOT> 画像を夕焼けにして', { messageReference: { messageID: '700', channelID: '700' } }))
      const [reply] = replies
      await waitForButtons(reply, '更新する')
      const fields = reply.state.embeds[0].fields
      assert.equal(fields.find(f => f.name === '変更する項目').value, '（文章の変更なし）')
      assert.equal(fields.find(f => f.name === '画像').value, 'AIで編集（1280×720）\n指示: 画像を夕焼けにして')
      assert.match(requests[1].body.contents[0].parts[0].text, /^Edit the attached image/)
      await press(reply, '更新する')
      await done
      const message = discord.find(c => c.method === 'PATCH' && c.url.endsWith('/messages/700'))
      assert.deepEqual(message.body.attachments, [{ id: 0, filename: 'image.jpg' }])
      assert.ok(message.files[0].file.equals(reply.state.files[0].file))
    })

    test('an image attached to the reply replaces the posted image, even without any text', async () => {
      const { channel, replies } = createChannel()
      const requests = installGemini([body => {
        assert.match(body.contents[0].parts[0].text, /## 依頼メッセージ\n画像を添付の画像に差し替えて/)
        // The model may well list the attachment and describe the change; the image is replaced once, without AI.
        return [call('submit_forum_post_draft', { found: true, channel_id: '206', title: '11/3 交流会', content: '参加したい人は書き込んでください', tags: ['募集中'], image_urls: [`${site.url}/poster.png`], image_instruction: '添付の画像に差し替える' })]
      }])
      const done = mentionEvent.handle(mention(channel, '<@BOT>', {
        messageReference: { messageID: '700', channelID: '700' },
        attachments: [{ url: `${site.url}/poster.png`, filename: 'poster.png', content_type: 'image/png' }]
      }))
      const [reply] = replies
      await waitForButtons(reply, '更新する')
      assert.equal(requests.length, 1, 'no image model call')
      const fields = reply.state.embeds[0].fields
      assert.equal(fields.find(f => f.name === '変更する項目').value, '（文章の変更なし）')
      assert.equal(fields.find(f => f.name === '画像').value, '切り抜き（1280×720）')
      await press(reply, '更新する')
      await done
      const message = discord.find(c => c.method === 'PATCH' && c.url.endsWith('/messages/700'))
      assert.deepEqual(message.body.attachments, [{ id: 0, filename: 'image.jpg' }])
      assert.ok(message.files[0].file.equals(reply.state.files[0].file))
    })

    test('keeping the image leaves the attachments untouched', async () => {
      const { channel, replies } = createChannel()
      installGemini([[call('submit_forum_post_draft', { found: true, channel_id: '206', title: '11/3 交流会', content: '本文を直しました', tags: ['募集中'] })]])
      const done = mentionEvent.handle(mention(channel, '<@BOT> 本文を直して', { messageReference: { messageID: '700', channelID: '700' } }))
      const [reply] = replies
      await waitForButtons(reply, '更新する')
      await press(reply, '更新する')
      await done
      const message = discord.find(c => c.method === 'PATCH' && c.url.endsWith('/messages/700'))
      assert.equal('attachments' in message.body, false)
      assert.equal(message.files, undefined)
    })

    test('changing an event needs Manage Events, and is refused before asking the model', async () => {
      const { channel, replies } = createChannel()
      const requests = installGemini([])
      await mentionEvent.handle(mention(channel, '<@BOT> 開始を20時にして', { member: createMember({ id: REQUESTER, permissions: [] }), messageReference: { messageID: '600', channelID: '201' } }))
      assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\nイベントを登録・変更するには「イベントの管理」権限が必要です。')
      assert.equal(requests.length, 0)
    })

    test('only what the bot made can be changed, and the request must say what to change', async () => {
      const { channel, replies } = createChannel()
      installGemini([])
      eventChanges = { creator_id: '3' }
      await mentionEvent.handle(mention(channel, '<@BOT> 開始を20時にして', { messageReference: { messageID: '600', channelID: '201' } }))
      assert.equal(replies[0].state.content, 'BOT が登録したイベントではないため、直せません。')

      eventChanges = { status: 3 }
      await mentionEvent.handle(mention(channel, '<@BOT> 開始を20時にして', { messageReference: { messageID: '600', channelID: '201' } }))
      assert.equal(replies[1].state.content, '終了または中止したイベントは直せません。')

      await mentionEvent.handle(mention(channel, '<@BOT>', { messageReference: { messageID: '600', channelID: '201' } }))
      assert.match(replies[2].state.content, /^直したいこと/)
      assert.equal(discord.filter(c => c.method === 'PATCH').length, 0)
    })
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
      assert.equal(replies[0].state.content, '⚠️ **作成できませんでした**\nなし')
      // The bot's role is stripped from the request; other role mentions are kept as written.
      assert.match(requests[0].body.contents[0].parts[0].text, /## 依頼メッセージ\n交流会 <@&801> と相談/)
    })

    test('ignores a mention of some other role', async () => {
      const { channel, replies } = createChannel()
      await mentionEvent.handle(mention(channel, '<@&801> 交流会'))
      assert.equal(replies.length, 0)
    })

    test('anyone can chat; an event needs Manage Events, checked when one is drafted', async () => {
      const { channel, replies } = createChannel()
      const member = () => createMember({ id: REQUESTER, permissions: [] })
      installGemini([[call('submit_chat_reply', { text: 'こんにちは！' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> こんにちは', { member: member() }))
      assert.equal(replies[0].state.content, 'こんにちは！')

      installGemini([[submit({ name: '交流会', start: '2026-11-03T19:00:00+09:00' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会を登録して', { member: member() }))
      assert.equal(replies[1].state.content, '⚠️ **作成できませんでした**\nイベントを登録・変更するには「イベントの管理」権限が必要です。')
      assert.deepEqual(replies[1].state.components, [])
      assert.equal(discord.some(c => c.method === 'POST'), false)
    })

    test('without Manage Events, a forum post can still be made where the requester can post', async () => {
      const { channel, replies } = createChannel()
      installGemini([[call('submit_forum_post_draft', { found: true, channel_id: '206', title: '募集', content: '本文', tags: ['募集中'] })]])
      const done = mentionEvent.handle(mention(channel, '<@BOT> 募集に立てて', { member: createMember({ id: REQUESTER, permissions: [] }) }))
      await waitForButtons(replies[0], '投稿する')
      await press(replies[0], '投稿する')
      await done
      assert.equal(discord.find(c => c.method === 'POST').url, '/channels/206/threads')

      installGemini([[call('submit_forum_post_draft', { found: true, channel_id: '207', title: '連絡', content: '本文' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> 運営連絡に立てて', { member: createMember({ id: REQUESTER, permissions: [] }) }))
      assert.equal(replies[1].state.content, '⚠️ **作成できませんでした**\n依頼者が <#207> に投稿する権限を持っていません。')
    })

    test('lets the server owner through without the permission', async () => {
      const { channel, replies } = createChannel()
      installGemini([[submit({ found: false, reason: 'なし' })]])
      await mentionEvent.handle(mention(channel, '<@BOT> 交流会', { author: guild.ownerID, member: createMember({ id: guild.ownerID, permissions: [] }) }))
      assert.match(replies[0].state.content, /作成できませんでした\*\*\nなし/)
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
      assert.match(replies[0].state.content, /話したいことか、イベントやフォーラム投稿にしたい内容/)
    })
  })
})
