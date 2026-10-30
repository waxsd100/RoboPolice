const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { installYouTubeStore } = require('../helpers/fakes')
const command = require('../../src/bot/slashcommands/youtube')

const UC = 'UC' + 'b'.repeat(22)

const Eris = require('eris')
const interactionCreate = require('../../src/bot/events/interactionCreate')

// A slash command interaction as Eris hands it over, recording what the command answers.
function interaction (sub, options = []) {
  const it = { guildID: '100', member: { user: { id: '1' } }, data: { options: [{ name: sub, options }] }, deferred: false, replies: [] }
  it.defer = async () => { it.deferred = true }
  it.editOriginalMessage = async m => { it.replies.push(m) }
  return it
}

// Waits for the confirmation buttons, then presses one as `userID` through the real handler.
async function press (it, label, userID = '1') {
  let button
  for (let i = 0; i < 200 && !button; i++) {
    button = it.replies.at(-1)?.components?.[0]?.components.find(b => b.label === label)
    if (!button) await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(button, `no ${label} button`)
  const click = Object.assign(Object.create(Eris.ComponentInteraction.prototype), {
    applicationID: 'BOT', data: { custom_id: button.custom_id }, member: { user: { id: userID } }, acknowledge: async () => {}
  })
  interactionCreate.handle(click)
}

// Runs /youtube set and answers its confirmation.
async function setChannel (it, answer = 'はい') {
  const done = command.func(it)
  await press(it, answer)
  await done
}

function fakeYouTubeApi () {
  const calls = []
  global.fetch = async url => {
    const path = new URL(url).pathname.split('/').pop()
    calls.push(path)
    const answers = {
      channels: { items: [{ id: UC, snippet: { title: 'のばまんch', description: '配信' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] },
      playlistItems: { items: [{ contentDetails: { videoId: 'v1' } }] },
      videos: { items: [{ id: 'v1', snippet: { title: '記念配信', publishedAt: '2026-10-28T00:00:00Z', liveBroadcastContent: 'upcoming' } }] }
    }
    return { ok: true, json: async () => answers[path] }
  }
  return calls
}

describe('/youtube', () => {
  let store
  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = 'yt-key'
    store = installYouTubeStore()
    global.bot = { user: { id: 'BOT' } }
  })

  test('is limited to members who can manage the server', () => {
    assert.deepEqual(command.userPerms, ['manageGuild'])
  })

  test('set: stores the channel, reads it at once, and shows what was stored', async () => {
    const calls = fakeYouTubeApi()
    const it = interaction('set', [{ name: 'channel', value: ' https://www.youtube.com/@nobaman ' }])
    await setChannel(it)
    assert.equal(it.deferred, true, 'deferred before calling YouTube')
    const question = it.replies[0]
    assert.equal(question.content, 'このチャンネルを設定しますか？')
    assert.equal(question.embeds[0].title, 'のばまんch')
    assert.deepEqual(question.components[0].components.map(b => b.label), ['はい', 'いいえ'])
    assert.deepEqual(store.writes, [{ setChannel: ['100', 'https://www.youtube.com/@nobaman', UC] }, { saveSync: '100', videos: ['v1'], backfillToken: null }])
    assert.deepEqual(calls, ['channels', 'channels', 'playlistItems', 'videos'], 'the channel is resolved before anything is stored')
    const reply = it.replies.at(-1)
    assert.match(reply.content, /設定し、情報を取得しました/)
    assert.deepEqual(reply.components, [], 'the buttons are gone')
    const fields = Object.fromEntries(reply.embeds[0].fields.map(f => [f.name, f.value]))
    assert.equal(reply.embeds[0].title, 'のばまんch')
    assert.equal(fields['保存している動画'], '1 件（内容の要約あり 0 件）')
    assert.equal(fields['配信'], '配信予定: [記念配信](https://www.youtube.com/watch?v=v1)')
  })

  test('set: rejects something that is not a channel', async () => {
    const it = interaction('set', [{ name: 'channel', value: 'https://www.youtube.com/watch?v=abc' }])
    await command.func(it)
    assert.match(it.replies[0].content, /YouTube チャンネルの URL/)
    assert.deepEqual(store.writes, [])
  })

  test('sync: needs a channel to be set first, then re-reads it', async () => {
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /`\/youtube set` で設定してください/)

    store.knowledge[100] = { channel: { channel_ref: `https://www.youtube.com/channel/${UC}`, synced_at: null }, videos: [] }
    fakeYouTubeApi()
    const again = interaction('sync')
    await command.func(again)
    assert.match(again.replies[0].content, /最新の情報を取得しました。新しく 1 件の動画を保存しました。/)
    assert.deepEqual(store.writes, [{ saveSync: '100', videos: ['v1'], backfillToken: null }])
  })

  test('sync: keeps what is stored and only adds what is new', async () => {
    store.knowledge[100] = {
      channel: { channel_ref: '@nobaman', channel_id: UC, synced_at: new Date('2026-10-01T00:00:00Z') },
      videos: [{ video_id: 'old1', title: '昔の動画', published_at: new Date('2025-01-01T00:00:00Z') }]
    }
    fakeYouTubeApi()
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /新しく 1 件の動画を保存しました。/)
    assert.deepEqual(store.knowledge[100].videos.map(v => v.video_id), ['v1', 'old1'])
  })

  test('set: setting the same channel again keeps what was accumulated', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@nobaman', channel_id: UC, synced_at: new Date() }, videos: [{ video_id: 'old1', title: 'x', published_at: new Date('2025-01-01T00:00:00Z') }] }
    fakeYouTubeApi()
    // Another way of writing the same channel still keeps what was accumulated.
    const it = interaction('set', [{ name: 'channel', value: `https://www.youtube.com/channel/${UC}` }])
    await setChannel(it)
    assert.equal(it.replies[0].content, 'このチャンネルを設定しますか？', 'nothing is said about deleting')
    assert.deepEqual(store.knowledge[100].videos.map(v => v.video_id), ['v1', 'old1'])
    assert.equal(store.knowledge[100].channel.channel_ref, `https://www.youtube.com/channel/${UC}`)
  })

  test('set: a channel that does not exist changes nothing', async (t) => {
    t.mock.method(global.logger, 'error', () => {})
    store.knowledge[100] = { channel: { channel_ref: '@nobaman', channel_id: UC, synced_at: new Date() }, videos: [{ video_id: 'old1', title: 'x' }] }
    global.fetch = async () => ({ ok: true, json: async () => ({ items: [] }) })
    const it = interaction('set', [{ name: 'channel', value: '@typo-name' }])
    await command.func(it)
    assert.equal(it.replies[0].content, 'YouTube の情報を取得できませんでした: YouTube チャンネルが見つかりませんでした')
    assert.deepEqual(store.writes, [])
    assert.equal(store.knowledge[100].videos.length, 1)
  })

  test('sync: says when older videos are left for the next sync, and saves where to continue', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@nobaman', channel_id: UC, synced_at: new Date() }, videos: [] }
    // Every page says there is another: the walk stops at the page limit.
    let page = 0
    global.fetch = async url => {
      const path = new URL(url).pathname.split('/').pop()
      if (path === 'channels') return { ok: true, json: async () => ({ items: [{ id: UC, snippet: { title: 'ch' }, contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] }) }
      if (path === 'playlistItems') {
        page++
        return { ok: true, json: async () => ({ items: [{ contentDetails: { videoId: `v${page}` } }], nextPageToken: `p${page}` }) }
      }
      const id = new URL(url).searchParams.get('id')
      return { ok: true, json: async () => ({ items: [{ id, snippet: { title: id, publishedAt: '2026-01-01T00:00:00Z' } }] }) }
    }
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /新しく 100 件の動画を保存しました。動画が多いため、残りの古い動画は次の `\/youtube sync` で続きから取得します（自動の取得でも続きを読みます）。/)
    assert.equal(store.writes[0].backfillToken, 'p100')
  })

  test('show: displays what is stored without calling YouTube', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: null }, videos: [] }
    global.fetch = async () => { throw new Error('must not call YouTube') }
    const it = interaction('show')
    await command.func(it)
    assert.equal(it.replies[0].embeds[0].fields.find(f => f.name === '最終取得').value, '未取得')
  })

  test('says so when the API key is not set', async () => {
    delete process.env.YOUTUBE_API_KEY
    const it = interaction('show')
    await command.func(it)
    assert.equal(it.replies[0].content, 'YOUTUBE_API_KEY が設定されていないため使えません。')
  })

  test('reports a YouTube failure with its hint, without leaking the key', async (t) => {
    t.mock.method(global.logger, 'error', () => {})
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'key=AIzaSyA1234567890abcdefghijklmnopqrstuv invalid' })
    const it = interaction('set', [{ name: 'channel', value: '@nobaman' }])
    await command.func(it)
    assert.equal(it.replies[0].content, 'YouTube の情報を取得できませんでした: YouTube API の呼び出しに失敗しました（HTTP 403）')
  })

  test('summarize: summarizes the newest unsummarized videos and lists the result', async () => {
    require('../helpers/fakes').configureGateway()
    store.knowledge[100] = {
      channel: { channel_ref: '@x', channel_id: UC },
      videos: [
        { video_id: 'newVideo001', title: '最新', url: 'https://www.youtube.com/watch?v=newVideo001', live_status: 'none' },
        { video_id: 'oldVideo001', title: '前回', url: 'https://www.youtube.com/watch?v=oldVideo001', live_status: 'none' }
      ]
    }
    require('../helpers/fakes').installGemini([[{ text: '要約' }]])
    const it = interaction('summarize', [{ name: 'count', value: 1 }])
    await command.func(it)
    assert.equal(it.replies[0].content, '動画の内容を要約しています（1/1）: 最新\n長い動画は1本で数分かかります。')
    assert.equal(it.replies[1].content, '1/1 本の動画を要約しました。メンションで依頼したときに AI が参照します。\n✅ [最新](https://www.youtube.com/watch?v=newVideo001)')
    assert.equal(store.summaries[100].newVideo001, '要約')
    assert.equal(it.replies.length, 2)

    const again = interaction('summarize', [{ name: 'count', value: 5 }])
    require('../helpers/fakes').installGemini([[{ text: '要約2' }]])
    await command.func(again)
    assert.match(again.replies.at(-1).content, /^1\/1 本の動画を要約しました。[\s\S]*前回/)
    const none = interaction('summarize')
    await command.func(none)
    assert.equal(none.replies[0].content, '要約していない動画はありません（配信中・配信予定のものは除きます）。`force:True` で要約し直せます。')

    require('../helpers/fakes').installGemini([[{ text: '作り直し' }]])
    const forced = interaction('summarize', [{ name: 'count', value: 1 }, { name: 'force', value: true }])
    await command.func(forced)
    assert.match(forced.replies.at(-1).content, /^1\/1 本の動画を要約し直しました。[\s\S]*最新/)
    assert.equal(store.summaries[100].newVideo001, '作り直し')
  })

  test('summarize: posts the result in the channel when the interaction can no longer be edited', async () => {
    require('../helpers/fakes').configureGateway()
    store.knowledge[100] = { channel: { channel_ref: '@x', channel_id: UC }, videos: [{ video_id: 'newVideo001', title: '最新', url: 'https://www.youtube.com/watch?v=newVideo001', live_status: 'none' }] }
    require('../helpers/fakes').installGemini([[{ text: '要約' }]])
    const posted = []
    global.bot = { createMessage: async (channelID, m) => posted.push([channelID, m.content]) }
    const it = interaction('summarize')
    it.channel = { id: '201' }
    it.editOriginalMessage = async () => { throw new Error('Unknown Webhook') }
    await command.func(it)
    assert.deepEqual(posted, [['201', '1/1 本の動画を要約しました。メンションで依頼したときに AI が参照します。\n✅ [最新](https://www.youtube.com/watch?v=newVideo001)']])
    delete global.bot
  })

  test('set: いいえ, or no answer, changes nothing; a different channel warns that the stored videos go', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@old', title: '前のch', channel_id: 'UC' + 'z'.repeat(22) }, videos: [{ video_id: 'old1', title: 'x' }] }
    fakeYouTubeApi()
    const it = interaction('set', [{ name: 'channel', value: '@nobaman' }])
    await setChannel(it, 'いいえ')
    assert.equal(it.replies[0].content, 'このチャンネルを設定しますか？\n⚠️ 今の「前のch」から変わり、保存している動画 1 件と情報は削除されます。')
    assert.equal(it.replies.at(-1).content, 'YouTube チャンネルの設定をやめました。')
    assert.deepEqual(store.writes, [])
  })

  test('set: only the member who ran it can answer', async () => {
    fakeYouTubeApi()
    const it = interaction('set', [{ name: 'channel', value: '@nobaman' }])
    const done = command.func(it)
    await press(it, 'はい', '2')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(store.writes, [], 'someone else pressing does nothing')
    await press(it, 'はい')
    await done
    assert.equal(store.writes.length, 2)
  })
})
