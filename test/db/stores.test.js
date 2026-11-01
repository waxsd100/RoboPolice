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

    test('the server\'s name, icon, member count and join time are kept with it', async () => {
      await create().createGuild(global.bot.guilds.get('g1'))
      const [row] = await q("SELECT name, member_count, details_updated_at IS NOT NULL AS updated FROM guilds WHERE id = 'g1'")
      assert.deepEqual(row, { name: 'テストサーバー', member_count: 42, updated: true })
      await update().saveGuildDetails({ id: 'g1', name: '新しい名前', iconURL: 'https://cdn/icon.png', ownerID: 'o9', memberCount: 50, joinedAt: Date.parse('2026-01-01T00:00:00Z') })
      const [after] = await q("SELECT name, icon_url, owner_id, member_count, joined_at FROM guilds WHERE id = 'g1'")
      assert.deepEqual(after, { name: '新しい名前', icon_url: 'https://cdn/icon.png', owner_id: 'o9', member_count: 50, joined_at: new Date('2026-01-01T00:00:00Z') })
      // Something Discord left out does not erase what is known.
      await update().saveGuildDetails({ id: 'g1', name: '新しい名前', memberCount: 51 })
      const [kept] = await q("SELECT owner_id, member_count, joined_at FROM guilds WHERE id = 'g1'")
      assert.deepEqual(kept, { owner_id: 'o9', member_count: 51, joined_at: new Date('2026-01-01T00:00:00Z') })
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
      // Unit vectors along different axes: m8 matches the query exactly, m6 is orthogonal to it.
      const axis = (i, sign = 1) => { const v = new Int8Array(512); v[i] = 127 * sign; return v }
      await store.saveMessageEmbeddings([
        { id: 'm8', embedding: axis(0), model: 'A' },
        { id: 'm6', embedding: axis(1), model: 'A' },
        { id: 'm7', embedding: axis(0), model: 'B' },
        { id: 'deleted', embedding: axis(0), model: 'A' }
      ], ['m8', 'm7', 'm6'])
      const nearest = await store.nearestMessages('g1', ['c1'], axis(0), { model: 'A', limit: 5 })
      assert.deepEqual(nearest.map(r => [r.message_id, Math.round(r.score * 100) / 100]), [['m8', 1], ['m6', 0]], 'nearest first, only model A, only stored messages')
      assert.deepEqual(await store.nearestMessages('g1', ['c2'], axis(0), { model: 'A' }), [], 'only the asked channels')
      assert.deepEqual((await store.nearestMessages('g1', ['c1'], axis(0), { model: 'A', limit: 1 })).map(r => r.message_id), ['m8'])
      assert.deepEqual((await q('SELECT name FROM embedding_models ORDER BY name')).map(r => r.name), ['A', 'B'], 'one row per model')
      const indexes = (await q("SELECT indexname FROM pg_indexes WHERE tablename IN ('message_embeddings', 'youtube_video_embeddings') AND indexdef LIKE '%hnsw%' ORDER BY indexname")).map(r => r.indexname)
      assert.deepEqual(indexes, ['message_embeddings_hnsw', 'youtube_video_embeddings_hnsw'])
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

  test('server emojis: kept in step, described once per name, embedded and searched by meaning', async () => {
    const emojis = require('../../src/db/interfaces/postgres/emojis')
    const axis = i => { const v = new Int8Array(512); v[i] = 127; return v }
    await emojis.syncEmojis('g1', [{ id: 'e1', name: 'kusa' }, { id: 'e2', name: 'naki', animated: true }])
    assert.deepEqual((await emojis.emojisToDescribe('g1', 10)).map(e => e.emoji_id), ['e1', 'e2'])
    await emojis.saveDescription('e1', 'kusa', '笑ったとき')
    await emojis.saveDescription('e2', 'naki', '悲しいとき')
    assert.deepEqual(await emojis.emojisToDescribe('g1', 10), [])
    assert.deepEqual((await emojis.emojisToEmbed('g1', 'A', 10)).map(e => e.emoji_id), ['e1', 'e2'])
    await emojis.saveEmbedding('e1', axis(0), 'A')
    await emojis.saveEmbedding('e2', axis(1), 'A')
    assert.deepEqual(await emojis.emojisToEmbed('g1', 'A', 10), [])
    assert.deepEqual((await emojis.emojisToEmbed('g1', 'B', 10)).length, 2, 'another model embeds them again')
    assert.deepEqual(await emojis.nearestEmojis('g1', axis(1), 'A', 5), ['e2', 'e1'])
    assert.deepEqual(await emojis.descriptions('g1'), { e1: '笑ったとき', e2: '悲しいとき' })

    // Renamed: described again. Gone from Discord: deleted.
    await emojis.syncEmojis('g1', [{ id: 'e1', name: 'www' }])
    assert.deepEqual((await emojis.emojisToDescribe('g1', 10)).map(e => e.name), ['www'])
    assert.deepEqual(await emojis.descriptions('g1'), { e1: '笑ったとき' })
  })

  test('the wiki: pages split in parts, unchanged parts keep their embedding, searched by meaning', async () => {
    const wiki = require('../../src/db/interfaces/postgres/wiki')
    const axis = i => { const v = new Int8Array(512); v[i] = 127; return v }
    const root = 'https://w.example'
    await wiki.savePage(`${root}/d/chars`, 'のばまんのキャラクター', [
      { heading: 'のばまんのキャラクター', text: 'はじめに', images: [] },
      { heading: 'よつろん', text: '四葉の笑顔', images: ['https://image01.seesaawiki.jp/a.png'] },
      { heading: 'クリーム', text: '謎の生物', images: [] }
    ])
    await wiki.savePage(`${root}/d/quotes`, '名言集', [{ heading: '名言', text: '有名な台詞', images: [] }])
    assert.equal((await wiki.sectionsToEmbed('A', 10)).length, 4)
    for (const [i, s] of (await wiki.sectionsToEmbed('A', 10)).entries()) await wiki.saveSectionEmbedding(s.url, s.position, axis(i), 'A')
    assert.deepEqual(await wiki.sectionsToEmbed('A', 10), [])
    assert.deepEqual((await wiki.nearestSections(axis(3), 'A', 2)).map(s => [s.title, s.heading]), [['名言集', '名言'], ['のばまんのキャラクター', 'のばまんのキャラクター']])
    assert.deepEqual(await wiki.characters(), [{ heading: 'よつろん', text: '四葉の笑顔' }, { heading: 'クリーム', text: '謎の生物' }])
    assert.deepEqual(await wiki.characterImages(), [{ heading: 'よつろん', image: 'https://image01.seesaawiki.jp/a.png' }])

    // Knowledge taken out of each part, once per version of the part.
    const pending = await wiki.sectionsToExtract(10)
    assert.equal(pending.length, 4)
    const yotsu = pending.find(p => p.heading === 'よつろん')
    await wiki.saveFacts(yotsu.url, yotsu.position, yotsu.text_hash, [{ kind: 'character', name: 'よつろん', aliases: ['yotsuron'], content: '四葉の笑顔' }])
    for (const p of pending.filter(p => p !== yotsu)) await wiki.saveFacts(p.url, p.position, p.text_hash, [])
    assert.deepEqual(await wiki.sectionsToExtract(10), [])
    const [fact] = await wiki.factsToEmbed('A', 10)
    await wiki.saveFactEmbedding(fact.id, axis(7), 'A')
    assert.deepEqual((await wiki.nearestFacts(axis(7), 'A', 1)).map(f => [f.kind, f.name, f.aliases, f.heading]), [['character', 'よつろん', ['yotsuron'], 'よつろん']])
    assert.deepEqual(await wiki.characterFacts(), [{ name: 'よつろん', aliases: ['yotsuron'], content: '四葉の笑顔' }])
    // The X posts have tables of their own, of the same shape: their characters are not the wiki's.
    const xKnowledge = require('../../src/db/interfaces/postgres/xKnowledge')
    const xPage = 'https://x.com/someone#2026-10'
    await xKnowledge.savePage(xPage, '@someone のポスト（2026年10月）', [{ heading: '2026年10月 1', text: '新キャラ登場', images: [] }])
    const [xPart] = await xKnowledge.sectionsToExtract(10)
    await xKnowledge.saveFacts(xPage, xPart.position, xPart.text_hash, [{ kind: 'character', name: '新キャラ', content: 'X に出てきた' }])
    assert.deepEqual((await wiki.characterFacts()).map(c => c.name), ['よつろん'])
    assert.deepEqual((await xKnowledge.characterFacts()).map(c => c.name), ['新キャラ'])
    assert.deepEqual(await wiki.sectionsToExtract(10), [], 'the wiki does not see the X posts')
    assert.deepEqual((await q('SELECT url FROM x_sections')).map(r => r.url), [xPage])
    assert.deepEqual((await q("SELECT url FROM wiki_pages WHERE url LIKE 'https://x.com/%'")), [])
    await xKnowledge.deletePagesExcept('https://x.com', [])
    assert.deepEqual(await q('SELECT name FROM x_facts'), [], 'knowledge goes with its page')

    // Read again with one part changed and one gone: only the changed one is embedded again.
    await wiki.savePage(`${root}/d/chars`, 'のばまんのキャラクター', [
      { heading: 'のばまんのキャラクター', text: 'はじめに', images: [] },
      { heading: 'よつろん', text: '四葉の笑顔（更新）', images: [] }
    ])
    assert.deepEqual((await wiki.sectionsToEmbed('A', 10)).map(s => s.heading), ['よつろん'])
    assert.deepEqual((await wiki.sectionsToExtract(10)).map(s => s.heading), ['よつろん'], 'a changed part is read again')
    assert.equal((await q('SELECT count(*)::int AS n FROM wiki_sections WHERE url = $1', [`${root}/d/chars`]))[0].n, 2)
    assert.ok(await wiki.lastRead(root))
    assert.equal(await wiki.deletePagesExcept(root, [`${root}/d/chars`]), 1)
    assert.deepEqual((await q('SELECT url FROM wiki_sections GROUP BY url')).map(r => r.url), [`${root}/d/chars`])
    assert.deepEqual((await q('SELECT name FROM wiki_facts')).map(r => r.name), ['よつろん'], 'knowledge goes with its page')
  })

  test('X posts: stored once each, read back by month in Japan time', async () => {
    const xPosts = require('../../src/db/interfaces/postgres/xPosts')
    const post = (id, at) => ({ id, account: 'nobamangames', url: `https://x.com/nobamangames/status/${id}`, text: `ポスト${id}`, createdAt: new Date(at) })
    const added = await xPosts.savePosts([post('1', '2026-09-30T16:00:00Z'), post('2', '2026-10-15T00:00:00Z')])
    assert.equal(added.length, 2)
    assert.deepEqual((await xPosts.savePosts([post('2', '2026-10-15T00:00:00Z'), post('3', '2026-10-31T14:59:00Z')])).map(p => p.id), ['3'])
    assert.deepEqual([...await xPosts.knownIds('nobamangames')].sort(), ['1', '2', '3'])
    // 2026-09-30T16:00Z is already October 1st in Japan.
    assert.deepEqual((await xPosts.postsOfMonth('nobamangames', '2026-10')).map(p => p.id), ['1', '2', '3'])
    assert.deepEqual(await xPosts.postsOfMonth('nobamangames', '2026-09'), [])
  })

  test('Discord messages: stored once (an edit replaces the text), by month in Japan time, deleted; history progress kept', async () => {
    const posts = require('../../src/db/interfaces/postgres/discordPosts')
    const tables = require('../../src/db/interfaces/postgres/discordKnowledge')
    const post = (id, content, at) => ({ id, guildID: 'g1', channelID: 'c1', channelName: '雑談', authorID: 'u1', authorName: 'のばまん', content, createdAt: new Date(at) })
    assert.equal((await posts.savePosts([post('d1', '告知', '2026-09-30T16:00:00Z'), post('d2', 'やあ', '2026-10-15T00:00:00Z')])).length, 2)
    assert.deepEqual((await posts.savePosts([post('d2', 'やあ', '2026-10-15T00:00:00Z')])), [], 'unchanged: not new')
    assert.equal((await posts.savePosts([post('d2', 'やあ（編集）', '2026-10-15T00:00:00Z')])).length, 1, 'edited')
    assert.deepEqual((await posts.postsOfMonth('g1', 'u1', '2026-10')).map(p => [p.id, p.content]), [['d1', '告知'], ['d2', 'やあ（編集）']])
    assert.equal((await posts.deletePost('d1')).author_id, 'u1')
    assert.equal(await posts.deletePost('d1'), null)
    assert.equal(await posts.backfillState('c1'), null)
    await posts.saveBackfill('g1', 'c1', '700', false)
    await posts.saveBackfill('g1', 'c1', '500', true)
    assert.deepEqual(await posts.backfillState('c1'), { before_id: '500', done: true })
    // Their knowledge tables are their own.
    await tables.savePage('https://discord.com/channels/g1#u1-2026-10', 'のばまん の Discord の発言（2026年10月）', [{ heading: '2026年10月 1', text: 'やあ', images: [] }])
    assert.deepEqual((await q('SELECT url FROM discord_sections')).map(r => r.url), ['https://discord.com/channels/g1#u1-2026-10'])
    assert.equal(await tables.deletePagesExcept('https://discord.com/channels/g1#u1-2026-10', []), 1)
  })

  test('topics looked up on the web: their own tables, pages of topics no longer named dropped', async () => {
    const web = require('../../src/db/interfaces/postgres/webKnowledge')
    await web.savePage('topic:ぽみそしる', '「ぽみそしる」について', [{ heading: 'ぽみそしる 1', text: 'メンバー: ポッキー、のばまん', images: [] }])
    await web.savePage('topic:昔のテーマ', '「昔のテーマ」について', [{ heading: '昔のテーマ 1', text: '古い', images: [] }])
    assert.ok(await web.lastRead('topic:ぽみそしる'))
    assert.equal(await web.deletePagesExcept('topic:', ['topic:ぽみそしる']), 1)
    assert.deepEqual((await q('SELECT url FROM web_sections')).map(r => r.url), ['topic:ぽみそしる'])
  })

  describe('YouTube', () => {
    const store = () => require('../../src/db/interfaces/postgres/youtube')
    const video = (id, extra = {}) => ({ id, title: `動画 ${id}`, description: '', publishedAt: `2026-10-0${id.slice(1)}T00:00:00Z`, liveStatus: 'none', scheduledStart: null, duration: 'PT1H', ...extra })
    const channel = { id: 'UC1', title: 'チャンネル', description: '説明', handle: '@chan', url: 'https://www.youtube.com/@chan' }

    test('the bot\'s channels are every server\'s: their videos are found from any server', async () => {
      await store().setBotChannels([{ ref: '@chan', id: 'UC1' }])
      await store().saveSync({ channel, videos: [video('v1'), video('v2', { liveStatus: 'upcoming' }), video('v1')] })
      assert.deepEqual([...await store().getVideoIds()].sort(), ['v1', 'v2'])
      assert.deepEqual([...await store().getVideoIds('UC1')].sort(), ['v1', 'v2'])
      for (const guild of ['g1', 'g2']) {
        const knowledge = await store().getKnowledge(guild)
        assert.equal(knowledge.channel.title, 'チャンネル')
        assert.equal(knowledge.channels[0].channel_ref, '@chan')
        assert.deepEqual(knowledge.videos.map(v => [v.video_id, v.url]), [['v2', 'https://www.youtube.com/watch?v=v2'], ['v1', 'https://www.youtube.com/watch?v=v1']])
      }
      assert.deepEqual(await store().getLiveVideoIds('UC1'), ['v2'])
      assert.deepEqual(await store().recentVideoIds('UC1', new Date('2026-10-01T12:00:00Z')), ['v2'])
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
      assert.deepEqual(overview.channels.map(c => [c.channel_id, c.video_count]), [['UC1', 2]])
    })

    test('a stream\'s archive is due for a summary a while after it ends, a few times at most', async () => {
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev9', status: 'active', scheduledStart: null, scheduledEnd: null })
      assert.equal((await q("SELECT ended_at FROM youtube_live_events WHERE video_id = 'v2' AND guild_id = 'g1'"))[0].ended_at, null)
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev9', status: 'completed', scheduledStart: null, scheduledEnd: null })
      assert.deepEqual(await store().archivesToSummarize('g1'), [], 'not right after it ends')
      assert.deepEqual(await store().archivesToSummarize('g1', { waitMinutes: 0 }), [{ video_id: 'v2', url: 'https://www.youtube.com/watch?v=v2' }])
      await store().recordArchiveAttempt('g1', 'v2')
      assert.deepEqual(await store().archivesToSummarize('g1', { waitMinutes: 0 }), [], 'not again within the hour')
      assert.deepEqual((await store().archivesToSummarize('g1', { waitMinutes: 0, retryMinutes: 0 })).length, 1)
      assert.deepEqual(await store().archivesToSummarize('g1', { waitMinutes: 0, retryMinutes: 0, maxAttempts: 1 }), [])
      const [first] = await q("SELECT ended_at FROM youtube_live_events WHERE video_id = 'v2' AND guild_id = 'g1'")
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev9', status: 'completed', scheduledStart: null, scheduledEnd: null })
      const [again] = await q("SELECT ended_at FROM youtube_live_events WHERE video_id = 'v2' AND guild_id = 'g1'")
      assert.deepEqual(again.ended_at, first.ended_at, 'the first end is kept')
      await q("UPDATE youtube_live_events SET archive_attempts = 0, archive_tried_at = NULL WHERE video_id = 'v2'")
      await store().saveSummary('g1', 'v2', '配信の要約')
      assert.deepEqual(await store().archivesToSummarize('g1', { waitMinutes: 0 }), [], 'not once summarized')
      await q("DELETE FROM guild_youtube_summaries WHERE video_id = 'v2'")
      await q("DELETE FROM youtube_summaries WHERE video_id = 'v2'")
      // An upload's event is not a stream: its video is never summarized as an archive.
      await q("DELETE FROM youtube_live_events WHERE video_id = 'v2'")
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev9', status: 'completed', kind: 'upload' })
      assert.equal((await store().getLiveEvents('g1')).v2.kind, 'upload')
      assert.deepEqual(await store().archivesToSummarize('g1', { waitMinutes: -1 }), [])
      await q("DELETE FROM youtube_live_events WHERE video_id = 'v2'")
    })

    test('stream events, settings and push subscriptions', async () => {
      await store().setLiveEvents('g1', true)
      await store().setLiveEvents('g2', false)
      await store().saveLiveEvent('g1', 'v2', { eventID: 'ev1', status: 'scheduled', scheduledStart: null, scheduledEnd: null })
      assert.equal((await store().getLiveEvents('g1')).v2.event_id, 'ev1')
      assert.equal((await store().getLiveEvents('g1', 'UC1')).v2.event_id, 'ev1')
      assert.deepEqual(await store().getLiveEvents('g1', 'UCother'), {})
      assert.deepEqual(await store().listLiveEventGuilds(), ['g1'])
      assert.equal((await store().getKnowledge('g1')).live_events, true)
      assert.equal((await store().getKnowledge('g2')).live_events, false)
      assert.deepEqual((await store().listChannels()).map(c => c.channel_id), ['UC1'])
      assert.equal(await store().isKnownChannel('UC1'), true)
      assert.deepEqual(await store().websubDue(new Date()), ['UC1'])
      await store().saveWebsub('UC1', new Date(Date.now() + 86400000))
      assert.deepEqual(await store().websubDue(new Date()), [])
    })

    test('video embeddings', async () => {
      const embeddings = require('../../src/db/interfaces/postgres/embeddings')
      assert.deepEqual((await embeddings.videosForEmbedding()).map(v => [v.video_id, v.summary, v.text_hash]).sort(), [['v1', '要約1', null], ['v2', null, null]])
      const axis = i => { const v = new Int8Array(512); v[i] = 127; return v }
      assert.equal(await embeddings.hasVideoEmbeddings('g2', 'A'), false)
      await embeddings.saveVideoEmbedding('v1', axis(0), 'h1', 'A')
      await embeddings.saveVideoEmbedding('v2', axis(1), 'h2', 'A')
      await embeddings.saveVideoEmbedding('nope', axis(0), 'h', 'A')
      assert.equal(await embeddings.hasVideoEmbeddings('g2', 'A'), true)
      const scores = await embeddings.videoScores('g2', axis(0), 'A')
      assert.deepEqual(Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, Math.round(s * 100) / 100])), { v1: 1, v2: 0 })
      assert.deepEqual(await embeddings.videoScores('g2', axis(0), 'B'), {})
    })

    test('a channel the bot stops following goes with its videos; summaries when no server asked for them', async () => {
      // Another channel added: the first keeps everything accumulated.
      await store().setBotChannels([{ ref: '@chan', id: 'UC1' }, { ref: '@other', id: 'UC2' }])
      assert.deepEqual((await store().listChannels()).map(c => [c.channel_id, c.channel_ref]), [['UC1', '@chan'], ['UC2', '@other']])
      assert.deepEqual([...await store().getVideoIds('UC1')].sort(), ['v1', 'v2'])
      assert.equal(await store().isKnownChannel('UC2'), true)

      // The first dropped: its videos, embeddings and stream events go.
      await store().setBotChannels([{ ref: '@other', id: 'UC2' }])
      assert.deepEqual(await q('SELECT channel_id FROM youtube_channels'), [{ channel_id: 'UC2' }])
      assert.deepEqual(await q('SELECT * FROM youtube_videos'), [])
      assert.deepEqual(await q('SELECT * FROM youtube_video_embeddings'), [])
      assert.deepEqual(await store().getLiveEvents('g1'), {})
      assert.equal(await store().isKnownChannel('UC1'), false)

      // Summaries stay while a server asked for them.
      assert.deepEqual((await q('SELECT video_id FROM youtube_summaries ORDER BY video_id')).map(r => r.video_id), ['v1', 'x9'])
      await store().deleteGuildYouTube('g2')
      await store().deleteGuildYouTube('g1')
      assert.deepEqual(await q('SELECT * FROM youtube_summaries'), [])
      assert.deepEqual(await q("SELECT * FROM guild_youtube WHERE guild_id IN ('g1', 'g2')"), [])
      await store().setBotChannels([])
      assert.deepEqual(await q('SELECT * FROM youtube_channels'), [])
      assert.equal(await store().getKnowledge('g1'), null)
    })
  })
})
