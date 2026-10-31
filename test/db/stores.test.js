// The stores on the migrated schema.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const database = require('./database')
const { installBot, createGuild } = require('../helpers/fakes')

describe('stores', { skip: !database.available && 'needs PGHOST' }, () => {
  let pool
  const q = async (sql, args) => (await pool.query(sql, args)).rows

  before(async () => {
    await database.create()
    pool = require('../../src/db/clients/postgres')
    await require('../../src/db/migrate').migrate()
    const guilds = [createGuild({ id: 'g1', ownerID: 'o1' }), createGuild({ id: 'g2', ownerID: 'o2' })]
    installBot({ guilds })
    global.bot.guilds = new Map(guilds.map(g => [g.id, g]))
    global.bot.guildSettingsCache = {}
  })
  after(() => database.drop())

  describe('server settings', () => {
    const create = () => require('../../src/db/interfaces/postgres/create')
    const read = () => require('../../src/db/interfaces/postgres/read')
    const update = () => require('../../src/db/interfaces/postgres/update')

    test('a new server logs nothing, and every event is listed', async () => {
      await create().createGuild({ id: 'g1', ownerID: 'o1' })
      const doc = await read().getGuild('g1')
      assert.equal(doc.owner_id, 'o1')
      assert.equal(doc.log_bots, false)
      assert.deepEqual(doc.ignored_channels, [])
      assert.equal(doc.event_logs.messageDelete, '')
      assert.equal(Object.keys(doc.event_logs).length, require('../../src/bot/utils/constants').ALL_EVENTS.length)
      assert.equal(global.bot.guildSettingsCache.g1.getEventByName('messageDelete'), '')
    })

    test('event log channels are set, moved, cleared by channel and cleared all', async () => {
      await update().setEventsLogId('g1', 'c1', ['messageDelete', 'messageUpdate'])
      await update().setEventsLogId('g1', 'c2', ['messageUpdate', 'channelCreate'])
      assert.deepEqual(global.bot.guildSettingsCache.g1.eventLogByNames('c2').sort(), ['channelCreate', 'messageUpdate'])
      await update().setEventsLogId('g1', '', ['channelCreate'])
      assert.deepEqual(await q('SELECT event, channel_id FROM guild_event_logs ORDER BY event'), [
        { event: 'messageDelete', channel_id: 'c1' }, { event: 'messageUpdate', channel_id: 'c2' }
      ])
      await update().clearEventByID('g1', 'c1')
      assert.deepEqual((await q('SELECT event FROM guild_event_logs')).map(r => r.event), ['messageUpdate'])
      await update().setAllEventsOneId('g1', 'c3')
      assert.ok(Object.values((await read().getGuild('g1')).event_logs).every(c => c === 'c3'))
      await update().setAllEventsOneId('g1', '')
      assert.deepEqual(await q('SELECT * FROM guild_event_logs'), [])
    })

    test('ignoring a channel toggles, and bots can be logged', async () => {
      assert.equal(await update().ignoreChannel('g1', 'c5'), true)
      assert.equal(global.bot.guildSettingsCache.g1.isChannelIgnored('c5'), true)
      assert.equal(await update().ignoreChannel('g1', 'c5'), false)
      await update().ignoreChannel('g1', 'c6')
      await update().clearIgnoredChannels('g1')
      assert.deepEqual((await read().getGuild('g1')).ignored_channels, [])
      assert.equal(await update().toggleLogBots('g1'), true)
      assert.equal(global.bot.guildSettingsCache.g1.isLogBots(), true)
    })

    test('a server made on first use, and its settings go with it', async () => {
      await update().setEventsLogId('g2', 'c1', ['messageDelete'])
      assert.equal((await read().getGuild('g2')).event_logs.messageDelete, 'c1')
      await require('../../src/db/interfaces/postgres/delete').deleteGuild('g2')
      assert.deepEqual(await q("SELECT * FROM guild_event_logs WHERE guild_id = 'g2'"), [])
    })
  })

  describe('messages', () => {
    const batcher = () => require('../../src/db/messageBatcher')

    test('a batch is stored with its images; edits and deletes reach them', async () => {
      for (let i = 0; i < 10; i++) await batcher().addItem([`m${i}`, 'u1', `text ${i}`, i === 0 ? ['https://cdn/a.png', 'https://cdn/b.png'] : [], `2026-10-0${i % 9 + 1}T00:00:00Z`, 'c1', 'g1'])
      const read = require('../../src/db/interfaces/postgres/read')
      const m0 = await read.getMessageById('m0')
      assert.equal(m0.content, 'text 0')
      assert.deepEqual(m0.attachment_urls, ['https://cdn/a.png', 'https://cdn/b.png'])

      const update = require('../../src/db/interfaces/postgres/update')
      await update.updateMessageByID('m0', { content: 'edited', imageUrls: ['https://cdn/b.png'] })
      const edited = await read.getMessageById('m0')
      assert.equal(edited.content, 'edited')
      assert.deepEqual(edited.attachment_urls, ['https://cdn/b.png'])

      assert.deepEqual((await read.getChannelHistory('c1', 2)).map(r => r.id), ['m8', 'm7'])

      await require('../../src/db/interfaces/postgres/delete').deleteMessage('m0')
      assert.deepEqual(await q("SELECT * FROM message_attachments WHERE message_id = 'm0'"), [])
    })

    test('message embeddings are searched through their message', async () => {
      const store = require('../../src/db/interfaces/postgres/embeddings')
      const pending = await store.pendingMessages(3)
      assert.deepEqual(pending.map(m => [m.id, m.content]), [['m8', 'text 8'], ['m7', 'text 7'], ['m6', 'text 6']])
      await store.saveMessageEmbeddings([{ id: 'm8', embedding: 'v8', model: 'A' }, { id: 'm7', embedding: 'v7', model: 'B' }, { id: 'deleted', embedding: 'x', model: 'A' }], ['m8', 'm7', 'm6'])
      const pages = []
      for await (const page of store.messageEmbeddingPages('g1', ['c1'], { model: 'A' })) pages.push(...page)
      assert.deepEqual(pages.map(r => [r.message_id, r.channel_id, r.embedding]), [['m8', 'c1', 'v8']])
      assert.deepEqual((await q('SELECT name FROM embedding_models ORDER BY name')).map(r => r.name), ['A', 'B'], 'one row per model')
      assert.equal(await store.resetStaleMessageEmbeddings('A', 10), 1)
      assert.deepEqual((await store.pendingMessages(10)).map(m => m.id).slice(0, 1), ['m7'])
    })
  })

  test('%reset clears the settings and keeps what is stored', async () => {
    await require('../../src/db/interfaces/postgres/update').setEventsLogId('g1', 'c1', ['messageDelete'])
    await require('../../src/db/interfaces/postgres/delete').resetGuild('g1')
    assert.deepEqual(await q("SELECT * FROM guild_event_logs WHERE guild_id = 'g1'"), [])
    assert.equal((await q("SELECT log_bots FROM guilds WHERE id = 'g1'"))[0].log_bots, false)
    assert.ok((await q("SELECT count(*)::int AS n FROM messages WHERE guild_id = 'g1'"))[0].n > 0)
  })

  describe('YouTube', () => {
    const store = () => require('../../src/db/interfaces/postgres/youtube')
    const video = (id, extra = {}) => ({ id, title: `動画 ${id}`, description: '', publishedAt: `2026-10-0${id.slice(1)}T00:00:00Z`, liveStatus: 'none', scheduledStart: null, duration: 'PT1H', ...extra })
    const channel = { id: 'UC1', title: 'チャンネル', description: '説明', handle: '@chan', url: 'https://www.youtube.com/@chan' }

    test('two servers with the same channel share its videos', async () => {
      await store().setChannel('g1', '@chan', 'UC1')
      await store().setChannel('g2', 'https://www.youtube.com/@chan', 'UC1')
      await store().saveSync('g1', { channel, videos: [video('v1'), video('v2', { liveStatus: 'upcoming' }), video('v1')] })
      assert.deepEqual([...await store().getVideoIds('g2')].sort(), ['v1', 'v2'])
      const knowledge = await store().getKnowledge('g2')
      assert.equal(knowledge.channel.title, 'チャンネル')
      assert.equal(knowledge.channel.channel_ref, 'https://www.youtube.com/@chan')
      assert.deepEqual(knowledge.videos.map(v => [v.video_id, v.url]), [['v2', 'https://www.youtube.com/watch?v=v2'], ['v1', 'https://www.youtube.com/watch?v=v1']])
      assert.deepEqual(await store().getLiveVideoIds('g1'), ['v2'])
      assert.deepEqual((await q('SELECT count(*)::int AS n FROM youtube_videos'))[0].n, 2)
    })

    test('a summary is made once and found by every server; other channels\' summaries are per server', async () => {
      await store().saveSummary('g1', 'v1', '要約1')
      assert.equal(await store().getSummary('v1'), '要約1')
      await store().saveSummary('g2', 'v1')
      await store().saveSummary('g1', 'x9', '他の動画')
      assert.deepEqual(await store().getOtherSummaries('g1'), [{ video_id: 'x9', summary: '他の動画' }])
      assert.deepEqual(await store().getOtherSummaries('g2'), [])
      const overview = await store().getOverview('g2')
      assert.deepEqual([overview.video_count, overview.summary_count, overview.live_count], [2, 1, 1])
    })

    test('stream events, settings and push subscriptions', async () => {
      await store().setLiveEvents('g1', true)
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev1', status: 'scheduled', scheduledStart: null, scheduledEnd: null })
      assert.equal((await store().getLiveEvents('g1')).v2.event_id, 'ev1')
      assert.deepEqual((await store().listChannels()).sort((a, b) => a.guild_id.localeCompare(b.guild_id)), [
        { guild_id: 'g1', channel_id: 'UC1', live_events: true }, { guild_id: 'g2', channel_id: 'UC1', live_events: false }
      ])
      assert.equal(await store().isKnownChannel('UC1'), true)
      assert.deepEqual(await store().websubDue(new Date()), ['UC1'])
      await store().saveWebsub('UC1', new Date(Date.now() + 86400000))
      assert.deepEqual(await store().websubDue(new Date()), [])
    })

    test('video embeddings', async () => {
      const embeddings = require('../../src/db/interfaces/postgres/embeddings')
      assert.deepEqual((await embeddings.videosForEmbedding()).map(v => [v.video_id, v.summary, v.text_hash]).sort(), [['v1', '要約1', null], ['v2', null, null]])
      await embeddings.saveVideoEmbedding('v1', 'e1', 'h1', 'A')
      await embeddings.saveVideoEmbedding('nope', 'e', 'h', 'A')
      assert.deepEqual(await embeddings.videoEmbeddings('g2', 'A'), { v1: 'e1' })
      assert.deepEqual(await embeddings.videoEmbeddings('g2', 'B'), {})
    })

    test('a channel goes when no server has it; summaries when no server asked for them', async () => {
      // g1 moves to another channel: its stream events go, the shared videos stay for g2.
      await store().setChannel('g1', '@other', 'UC2')
      assert.deepEqual(await store().getLiveEvents('g1'), {})
      assert.deepEqual([...await store().getVideoIds('g1')], [])
      assert.equal((await store().getOverview('g1')).synced_at, null)
      assert.deepEqual([...await store().getVideoIds('g2')].sort(), ['v1', 'v2'])

      await store().deleteGuildYouTube('g2')
      assert.deepEqual(await q('SELECT channel_id FROM youtube_channels'), [{ channel_id: 'UC2' }])
      assert.deepEqual(await q('SELECT * FROM youtube_videos'), [])
      assert.deepEqual(await q('SELECT * FROM youtube_video_embeddings'), [])
      // g1 still asked for both of its summaries.
      assert.deepEqual((await q('SELECT video_id FROM youtube_summaries ORDER BY video_id')).map(r => r.video_id), ['v1', 'x9'])
      await store().deleteGuildYouTube('g1')
      assert.deepEqual(await q('SELECT * FROM youtube_summaries'), [])
      assert.deepEqual(await q('SELECT * FROM youtube_channels'), [])
    })

    test('a server set before channel IDs were stored gets one on its sync', async () => {
      await q("INSERT INTO guilds (id, owner_id) VALUES ('g3', 'o3')")
      await q("INSERT INTO guild_youtube (guild_id, channel_ref) VALUES ('g3', '@legacy')")
      assert.equal((await store().getOverview('g3')).channel_id, null)
      await store().saveSync('g3', { channel: { ...channel, id: 'UC3' }, videos: [video('v3')] })
      assert.equal((await store().getOverview('g3')).channel_id, 'UC3')
      assert.deepEqual([...await store().getVideoIds('g3')], ['v3'])
    })
  })
})
