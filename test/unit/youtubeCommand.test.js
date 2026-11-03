const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installYouTubeStore } = require('../helpers/fakes')
const command = require('../../src/bot/slashcommands/youtube')

const UC = 'UC' + 'b'.repeat(22)

// A slash command interaction as Eris hands it over, recording what the command answers.
function interaction (sub, options = []) {
  const it = { guildID: '100', member: { user: { id: '1' } }, data: { options: [{ name: sub, options }] }, deferred: false, replies: [] }
  it.defer = async () => { it.deferred = true }
  it.editOriginalMessage = async m => { it.replies.push(m) }
  return it
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
    // Server 100 is the owner's: it may read the channels again.
    process.env.OWNER_GUILD_IDS = '100'
    store = installYouTubeStore()
    global.bot = { user: { id: 'BOT' } }
    // Summarized right away here; the Batch API has its own tests below.
    process.env.VIDEO_SUMMARY_BATCH = 'false'
  })
  afterEach(() => {
    delete process.env.OWNER_GUILD_IDS
    delete process.env.VIDEO_SUMMARY_BATCH
  })

  test('is limited to members who can manage the server', () => {
    assert.deepEqual(command.userPerms, ['manageGuild'])
  })

  test('there is no set: the channels are the bot\'s', () => {
    const { commands } = require('../../src/bot/utils/slashcommandconstants')
    assert.deepEqual(commands.find(c => c.name === 'youtube').options.map(o => o.name), ['sync', 'summarize', 'liveevents', 'show'])
  })

  test('sync: says when the bot follows no channel; reads every channel again, from the owner\'s servers only', async () => {
    const it = interaction('sync')
    await command.func(it)
    assert.match(it.replies[0].content, /BOT が見ている YouTube チャンネルがありません/)

    store.knowledge[100] = { channel: { channel_ref: UC, channel_id: UC, synced_at: null }, videos: [] }
    fakeYouTubeApi()
    const elsewhere = interaction('sync')
    elsewhere.guildID = '999'
    await command.func(elsewhere)
    assert.match(elsewhere.replies[0].content, /オーナーのサーバーからのみ/)
    assert.deepEqual(store.writes, [])

    const again = interaction('sync')
    await command.func(again)
    assert.match(again.replies[0].content, /最新の情報を取得しました。新しく 1 件の動画を保存しました。/)
    assert.deepEqual(store.writes, [{ saveSync: UC, videos: ['v1'], backfillToken: null }])
    const embed = again.replies[0].embeds[0]
    assert.equal(embed.title, 'BOT が見ている YouTube チャンネル')
    assert.match(embed.description, /のばまんch.*動画 1 件（要約あり 0 件）/)
    assert.equal(embed.fields.find(f => f.name === '配信').value, '配信予定: [記念配信](https://www.youtube.com/watch?v=v1)')
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

  test('show: displays the bot\'s channels without calling YouTube, in any server', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@x', title: 'のばまんch', synced_at: null }, videos: [] }
    store.knowledge[200] = { channel: { channel_ref: '@y', channel_id: 'UC' + 'y'.repeat(22), title: '別ch', synced_at: null }, videos: [] }
    global.fetch = async () => { throw new Error('must not call YouTube') }
    const it = interaction('show')
    it.guildID = '999'
    await command.func(it)
    const { description } = it.replies[0].embeds[0]
    assert.match(description, /のばまんch: 動画 0 件（要約あり 0 件）、最終取得 未取得/)
    assert.match(description, /別ch/)
  })

  test('says so when the API key is not set', async () => {
    delete process.env.YOUTUBE_API_KEY
    const it = interaction('show')
    await command.func(it)
    assert.equal(it.replies[0].content, 'YOUTUBE_API_KEY が設定されていないため使えません。')
  })

  test('reports a YouTube failure with its hint, without leaking the key', async (t) => {
    t.mock.method(global.logger, 'error', () => {})
    store.knowledge[100] = { channel: { channel_ref: '@nobaman', channel_id: UC, synced_at: null }, videos: [] }
    global.fetch = async () => ({ ok: false, status: 403, text: async () => 'key=AIzaSyA1234567890abcdefghijklmnopqrstuv invalid' })
    const it = interaction('sync')
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
    assert.equal(it.replies[0].content, '動画の内容を要約しています（完了 0/1、1 本を同時に処理中）\n・[最新](<https://www.youtube.com/watch?v=newVideo001>)（ID: `newVideo001`）\n長い動画は1本で数分かかります。')
    assert.equal(it.replies[1].content, '1/1 本の動画を要約しました。メンションで依頼したときに AI が参照します。\n✅ [最新](<https://www.youtube.com/watch?v=newVideo001>)')
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

  test('summarize: up to 50 videos; failures first, and what does not fit in one message is counted', async () => {
    require('../helpers/fakes').configureGateway()
    const videos = Array.from({ length: 60 }, (_, i) => {
      const id = `video${String(i).padStart(6, '0')}`
      return { video_id: id, title: `とても長いタイトルの動画 その${i} ${'あ'.repeat(30)}`, url: `https://www.youtube.com/watch?v=${id}`, live_status: 'none' }
    })
    store.knowledge[100] = { channel: { channel_ref: '@x', channel_id: UC }, videos }
    // One video fails (Gemini returns nothing), the rest are summarized.
    require('../helpers/fakes').installGemini(Array.from({ length: 50 }, (_, i) => [{ text: i === 7 ? '' : `要約${i}` }]))
    const it = interaction('summarize', [{ name: 'count', value: 50 }])
    await command.func(it)
    const result = it.replies.at(-1).content
    assert.ok(result.startsWith('49/50 本の動画を要約しました。'))
    assert.match(result.split('\n')[1], /^⚠️ \[とても長いタイトルの動画 その7 [^\]]*\]\(<https:\/\/www\.youtube\.com\/watch\?v=[^>]+>\)（ID: `[^`]+`）: /, 'the failure comes first')
    assert.ok(result.length <= 2000)
    assert.match(result, /\n…ほか \d+ 本$/)
    assert.equal(Object.keys(store.summaries[100]).length, 49)
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
    assert.deepEqual(posted, [['201', '1/1 本の動画を要約しました。メンションで依頼したときに AI が参照します。\n✅ [最新](<https://www.youtube.com/watch?v=newVideo001>)']])
    delete global.bot
  })

  test('summarize url: summarizes one video by its link, even with no channel set, and shows the summary', async () => {
    require('../helpers/fakes').configureGateway()
    const requests = require('../helpers/fakes').installGemini([[{ text: '・告知あり' }]])
    const it = interaction('summarize', [{ name: 'url', value: ' https://youtu.be/dQw4w9WgXcQ ' }])
    await command.func(it)
    assert.equal(requests[0].body.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    assert.equal(it.replies[0].content, '動画の内容を要約しています…\n長い動画は数分かかります。')
    assert.equal(it.replies.at(-1).content, '要約しました。メンションで依頼したときに AI が参照します。\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\n・告知あり')
    assert.equal(store.summaries[100].dQw4w9WgXcQ, '・告知あり')

    const cached = interaction('summarize', [{ name: 'url', value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }])
    require('../helpers/fakes').installGemini([])
    await command.func(cached)
    assert.match(cached.replies.at(-1).content, /^保存済みの要約です（`force:True` で要約し直せます）。/)

    require('../helpers/fakes').installGemini([[{ text: '・作り直し' }]])
    const forced = interaction('summarize', [{ name: 'url', value: 'https://youtu.be/dQw4w9WgXcQ' }, { name: 'force', value: true }])
    await command.func(forced)
    assert.match(forced.replies.at(-1).content, /^要約し直しました。[\s\S]*・作り直し$/)
  })

  test('summarize url: rejects a link that is not a video', async () => {
    const it = interaction('summarize', [{ name: 'url', value: 'https://www.youtube.com/@nobaman' }])
    await command.func(it)
    assert.match(it.replies[0].content, /YouTube の動画リンク/)
  })

  test('liveevents: turns stream events on and off, and needs Manage Events to turn them on', async () => {
    store.knowledge[100] = { channel: { channel_ref: '@x', channel_id: UC }, videos: [] }
    const perms = { ok: false }
    global.bot = { user: { id: 'BOT' }, guilds: new Map([['100', { members: new Map([['BOT', { permissions: { has: p => p === 'manageEvents' && perms.ok } }]]) }]]) }
    const refused = interaction('liveevents', [{ name: 'enabled', value: true }])
    await command.func(refused)
    assert.match(refused.replies[0].content, /「イベントの管理」権限がない/)
    assert.deepEqual(store.writes, [])

    perms.ok = true
    const on = interaction('liveevents', [{ name: 'enabled', value: true }])
    await command.func(on)
    assert.match(on.replies[0].content, /サーバーのイベントとして自動で登録します/)
    assert.deepEqual(store.writes, [{ setLiveEvents: ['100', true] }])

    const shown = interaction('show')
    await command.func(shown)
    assert.equal(shown.replies[0].embeds[0].fields.find(f => f.name === '配信・新着動画のイベント登録').value, '有効')

    const off = interaction('liveevents', [{ name: 'enabled', value: false }])
    await command.func(off)
    assert.match(off.replies[0].content, /やめました/)
  })

  describe('summarize with the Batch API', () => {
    const summaryBatch = require('../../src/bot/modules/summaryBatch')
    const batchStore = require('../../src/db/interfaces/postgres/summaryBatches')
    let batches
    beforeEach(() => {
      delete process.env.VIDEO_SUMMARY_BATCH
      require('../helpers/fakes').configureGateway()
      batches = []
      batchStore.saveBatch = async b => { batches.push({ name: b.name, guild_id: b.guildID, channel_id: b.channelID, requester_id: b.requesterID, video_ids: b.videoIDs, model: b.model }) }
      batchStore.runningBatches = async guildID => batches.filter(b => !guildID || b.guild_id === guildID)
      batchStore.deleteBatch = async name => { batches = batches.filter(b => b.name !== name) }
    })

    // A fake Gemini that takes a batch, says it is running once, then gives `results`.
    function fakeBatchApi (results) {
      const requests = []
      let polls = 0
      global.fetch = async (url, init = {}) => {
        // The YouTube API, for a video's length: an hour.
        if (url.includes('googleapis.com/youtube')) return { ok: true, json: async () => ({ items: [{ id: 'x', snippet: { title: 't', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { duration: 'PT1H' } }] }) }
        requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null })
        if (url.endsWith(':generateContent')) return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: `・すぐの要約 ${requests.length}` }] } }] }) }
        if (url.endsWith(':batchGenerateContent')) return { ok: true, json: async () => ({ name: 'batches/b1', metadata: { state: 'BATCH_STATE_PENDING' } }) }
        if (url.endsWith('/batches/b1')) {
          polls++
          if (polls === 1) return { ok: true, json: async () => ({ name: 'batches/b1', metadata: { state: 'BATCH_STATE_RUNNING' } }) }
          return { ok: true, json: async () => ({ name: 'batches/b1', metadata: { state: 'BATCH_STATE_SUCCEEDED' }, response: { inlinedResponses: { inlinedResponses: results } } }) }
        }
        throw new Error(`unexpected ${url}`)
      }
      return requests
    }
    const answer = (key, text) => ({ metadata: { key }, response: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 10 } } })

    test('the newest and short videos are summarized at once on Flex; the rest go to Gemini as one batch, stored and told when done', async (t) => {
      t.mock.method(global.logger, 'info', () => {})
      store.knowledge[100] = {
        channel: { channel_id: UC, title: 'のばまんch' },
        videos: [
          { video_id: 'newestvideo', title: '最新', url: 'https://youtu.be/newestvideo', duration: 'PT40M' },
          { video_id: 'longvideo01', title: '一', url: 'https://youtu.be/longvideo01', duration: 'PT2H' },
          { video_id: 'shortvideo1', title: 'ショート', url: 'https://youtu.be/shortvideo1', duration: 'PT45S' },
          { video_id: 'longvideo02', title: '二', url: 'https://youtu.be/longvideo02', duration: 'PT1H' }
        ]
      }
      const requests = fakeBatchApi([answer('longvideo02', '・二の要約'), { metadata: { key: 'longvideo01' }, error: { message: 'internal' } }])
      const posted = []
      global.bot.createMessage = async (channelID, message) => { posted.push({ channelID, ...message }) }
      const it = interaction('summarize', [{ name: 'count', value: 4 }])
      it.channel = { id: '201' }
      it.member = { id: '1', user: { id: '1' } }
      await command.func(it)
      const sent = requests.find(r => r.url.endsWith(':batchGenerateContent'))
      assert.match(sent.url, /models\/gemini-3\.8-flash:batchGenerateContent$/)
      const inline = sent.body.batch.input_config.requests.requests
      assert.deepEqual(inline.map(r => r.metadata.key), ['longvideo01', 'longvideo02'], 'only the long, older ones wait')
      assert.equal(inline[0].request.contents[0].parts[0].fileData.fileUri, 'https://www.youtube.com/watch?v=longvideo01')
      const quick = requests.filter(r => r.url.endsWith(':generateContent'))
      assert.deepEqual(quick.map(r => r.body.contents[0].parts[0].fileData.fileUri).sort(), ['https://www.youtube.com/watch?v=newestvideo', 'https://www.youtube.com/watch?v=shortvideo1'])
      assert.ok(quick.every(r => r.body.serviceTier === 'flex'), 'on Flex')
      assert.match(it.replies.at(-1).content, /^2 本の動画の要約を、AI にまとめて依頼しました（Batch API[\s\S]*\n2\/2 本の動画を要約しました。/)
      assert.ok(store.summaries[100].newestvideo && store.summaries[100].shortvideo1)
      assert.deepEqual(batches.map(b => [b.name, b.channel_id, b.requester_id]), [['batches/b1', '201', '1']])

      const again = interaction('summarize', [{ name: 'count', value: 4 }])
      again.channel = { id: '201' }
      await command.func(again)
      assert.match(again.replies.at(-1).content, /前にまとめて依頼した要約がまだ終わっていません/)
      assert.equal(requests.filter(r => r.url.endsWith(':batchGenerateContent')).length, 1)

      await summaryBatch.checkAll()
      assert.equal(posted.length, 0, 'still running')
      await summaryBatch.checkAll()
      assert.equal(store.summaries[100].longvideo02, '・二の要約')
      assert.equal(store.summaries[100].longvideo01, undefined)
      assert.equal(posted[0].channelID, '201')
      assert.match(posted[0].content, /^<@1> 1\/2 本の動画を要約しました。[\s\S]*⚠️ https:\/\/youtu\.be\/longvideo01 : [\s\S]*✅ <https:\/\/youtu\.be\/longvideo02>/)
      assert.deepEqual(posted[0].allowedMentions, { users: ['1'] })
      assert.equal(batches.length, 0, 'done with')
    })

    test('one video by its link: a stored summary is shown at once, a new one goes in a batch and is shown when done', async () => {
      const requests = fakeBatchApi([answer('dQw4w9WgXcQ', '・告知あり')])
      const posted = []
      global.bot.createMessage = async (channelID, message) => { posted.push({ channelID, ...message }) }
      const it = interaction('summarize', [{ name: 'url', value: 'https://youtu.be/dQw4w9WgXcQ' }])
      it.channel = { id: '201' }
      await command.func(it)
      assert.match(it.replies.at(-1).content, /^1 本の動画の要約を、AI にまとめて依頼しました/)
      assert.equal(requests.length, 1)
      await summaryBatch.checkAll()
      await summaryBatch.checkAll()
      assert.match(posted[0].content, /動画を要約しました。[\s\S]*https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ\n・告知あり$/)

      const cached = interaction('summarize', [{ name: 'url', value: 'https://youtu.be/dQw4w9WgXcQ' }])
      await command.func(cached)
      assert.match(cached.replies.at(-1).content, /^保存済みの要約です/)
      assert.equal(requests.length, 3, 'no new batch for a stored summary')
    })

    test('one short video by its link is summarized at once on Flex', async () => {
      store.knowledge[100] = { channel: { channel_id: UC, title: 'のばまんch' }, videos: [{ video_id: 'newestvideo', title: '最新', url: 'https://youtu.be/newestvideo', duration: 'PT1H' }, { video_id: 'shrt1234567', title: 'ショート', url: 'https://youtu.be/shrt1234567', duration: 'PT30S' }] }
      const requests = fakeBatchApi([])
      const it = interaction('summarize', [{ name: 'url', value: 'https://youtu.be/shrt1234567' }])
      await command.func(it)
      assert.equal(requests.length, 1)
      assert.match(requests[0].url, /:generateContent$/)
      assert.equal(requests[0].body.serviceTier, 'flex')
      assert.match(it.replies.at(-1).content, /^要約しました。/)
    })

    test('a batch that failed at Gemini is reported and dropped', async (t) => {
      t.mock.method(global.logger, 'warn', () => {})
      batches.push({ name: 'batches/b9', guild_id: '100', channel_id: '201', requester_id: null, video_ids: ['v1'], model: 'gemini-3.8-flash' })
      global.fetch = async () => ({ ok: true, json: async () => ({ name: 'batches/b9', metadata: { state: 'BATCH_STATE_EXPIRED' } }) })
      const posted = []
      global.bot.createMessage = async (channelID, message) => { posted.push(message) }
      await summaryBatch.checkAll()
      assert.match(posted[0].content, /できませんでした: Gemini の処理が expired で終わりました/)
      assert.equal(batches.length, 0)
    })
  })
})
