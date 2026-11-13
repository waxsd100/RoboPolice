const { test, describe, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { createGuild, createMember, installBot, installMentionLogStore, configureGateway } = require('../helpers/fakes')
const { safeLinks } = require('../../src/bot/utils/linkSafety')
const { createTools, withServerEmojis, withServerChannels } = require('../../src/bot/modules/eventTools')
const postedEdit = require('../../src/bot/modules/postedEdit')
const { splitChatMessages } = require('../../src/bot/modules/mentionEvent')
const { redact } = require('../../src/bot/utils/redact')
const { scanText } = require('../../src/miscellaneous/checkSecrets')
const websub = require('../../src/miscellaneous/websub')
const { partClips } = require('../../src/bot/modules/videoSummary')

describe('linkSafety: YouTube hostname validation', () => {
  test('accepts genuine YouTube domains and rejects lookalike/arbitrary domains embedding a 11-char video ID', () => {
    const id = 'dQw4w9WgXcQ'
    const allowed = [`https://www.youtube.com/watch?v=${id}`]
    const text = [
      `本物1 https://youtu.be/${id}`,
      `本物2 https://www.youtube-nocookie.com/embed/${id}`,
      `偽物1 https://evil.example/watch?v=${id}`,
      `偽物2 https://notyoutube.com/watch?v=${id}`,
      `偽物3 https://youtu.be.evil.example/${id}`
    ].join(' / ')
    const { text: cleaned, removed } = safeLinks(text, allowed)
    assert.match(cleaned, /https:\/\/youtu\.be\/dQw4w9WgXcQ/)
    assert.match(cleaned, /https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/)
    assert.doesNotMatch(cleaned, /evil\.example/)
    assert.doesNotMatch(cleaned, /notyoutube\.com/)
    assert.equal(removed.length, 3)
  })
})

describe('eventTools: private thread membership & code/URL-safe formatting', () => {
  test('blocks reading a private thread (type 12) when requester is not a thread member and lacks manageThreads', async () => {
    const guild = createGuild({
      id: '100',
      channels: [
        { id: '201', name: 'general', type: 0, readers: ['1', '2', 'BOT'] },
        { id: '212', name: 'secret-thread', type: 12, readers: ['1', '2', 'BOT'], moderators: [] }
      ]
    })
    const outsider = createMember({ id: '1' })
    const insider = createMember({ id: '2' })
    const thread = guild.channels.get('212')
    thread.members = new Map([['2', { id: '2' }]])

    installBot({
      guilds: [guild],
      messages: { '212/900': { id: '900', content: '機密の相談', author: { id: '2', username: 'in' }, timestamp: 1700000000000 } }
    })

    const outsiderTools = createTools({ guild, member: outsider, ask: async () => '' })
    const res1 = await outsiderTools.call('get_recent_messages', { channel_id: '212' })
    assert.match(res1.error || '', /プライベートスレッド/)

    const insiderTools = createTools({ guild, member: insider, ask: async () => '' })
    const res2 = await insiderTools.call('get_discord_message', { link: 'https://discord.com/channels/100/212/900' })
    assert.match(res2.result || '', /機密の相談/)
  })

  test('withServerEmojis and withServerChannels leave code spans, code blocks, URLs, and timestamps untouched', () => {
    const guild = createGuild({
      channels: [{ id: '201', name: 'general', type: 0, readers: ['1', 'BOT'] }]
    })
    guild.emojis = [{ id: '11', name: 'party', animated: true }, { id: '12', name: '30' }]
    const member = createMember({ id: '1' })

    const emojiInput = '時刻 19:30:00 と `:party: in code` と ```js\nconst x = ":party:"\n``` と https://example.com/:party:/x と :party:'
    assert.equal(
      withServerEmojis(emojiInput, guild),
      '時刻 19:30:00 と `:party: in code` と ```js\nconst x = ":party:"\n``` と https://example.com/:party:/x と <a:party:11>'
    )

    const chanInput = '`#general` と ```\n#general\n``` と https://example.com/page#general と #general'
    assert.equal(
      withServerChannels(chanInput, guild, member),
      '`#general` と ```\n#general\n``` と https://example.com/page#general と <#201>'
    )
  })
})

describe('postedEdit: forum authorization, locked threads, ownership, and kind-mismatch safety', () => {
  let logs
  beforeEach(() => {
    logs = installMentionLogStore([])
  })

  test('refuses forum edit when requester cannot post, thread is locked, or another user created the post', async () => {
    const guild = createGuild({
      id: '100',
      channels: [
        { id: '301', name: '募集', type: 15, posters: ['1', '2', '9', 'BOT'], moderators: ['9'] },
        { id: '302', name: '告知専用', type: 15, posters: ['BOT'], moderators: ['9'] }
      ]
    })
    installBot({
      guilds: [guild],
      forums: {
        301: { available_tags: [{ id: 't1', name: '募集中' }] },
        302: { available_tags: [] },
        7001: { id: '7001', type: 11, guild_id: '100', parent_id: '301', name: 'Aの募集', applied_tags: ['t1'], thread_metadata: { locked: false } },
        7002: { id: '7002', type: 11, guild_id: '100', parent_id: '302', name: '運営告知', applied_tags: [], thread_metadata: { locked: false } },
        7003: { id: '7003', type: 11, guild_id: '100', parent_id: '301', name: 'ロック済み', applied_tags: [], thread_metadata: { locked: true } }
      },
      messages: {
        '7001/7001': { id: '7001', content: 'Aの本文', author: { id: 'BOT', username: 'bot' }, timestamp: 1700000000000 },
        '7002/7002': { id: '7002', content: '告知本文', author: { id: 'BOT', username: 'bot' }, timestamp: 1700000000000 },
        '7003/7003': { id: '7003', content: 'ロック本文', author: { id: 'BOT', username: 'bot' }, timestamp: 1700000000000 }
      }
    })

    // Read-only forum: regular member cannot load starter message for editing
    await assert.rejects(
      postedEdit.load(guild, { kind: 'forum', id: '7002' }, createMember({ id: '1' })),
      /投稿する権限がない/
    )

    // Locked thread: regular member cannot edit, moderator can
    await assert.rejects(
      postedEdit.load(guild, { kind: 'forum', id: '7003' }, createMember({ id: '1' })),
      /ロックされたスレッド/
    )
    const modLoaded = await postedEdit.load(guild, { kind: 'forum', id: '7003' }, createMember({ id: '9' }))
    assert.equal(modLoaded.current.title, 'ロック済み')

    // Creator ownership recorded in mention_logs: user 2 cannot edit user 1's post, user 1 can
    logs.push({
      id: '1',
      guild_id: '100',
      kind: 'forum',
      user_id: '1',
      response: 'フォーラムに投稿しました: https://discord.com/channels/100/7001'
    })
    await assert.rejects(
      postedEdit.load(guild, { kind: 'forum', id: '7001' }, createMember({ id: '2' })),
      /他のメンバーが作成したフォーラム投稿/
    )
    const ownerLoaded = await postedEdit.load(guild, { kind: 'forum', id: '7001' }, createMember({ id: '1' }))
    assert.equal(ownerLoaded.current.title, 'Aの募集')

    // changes() never throws when result.kind differs (e.g. chat answer instead of forum/event)
    assert.deepEqual(postedEdit.changes(ownerLoaded, { kind: 'chat', text: '質問への返答' }), [])
  })
})

describe('splitChatMessages: 2000-character Discord limit with debug footer', () => {
  test('never exceeds 2000 chars when trailing spaces and leading newline in footer combine', () => {
    const footer = '\n-# model: gemini-3.8-flash · tokens: in 100 / out 20'
    const body = 'あ'.repeat(2000 - footer.length) + '   '
    const chunks = splitChatMessages(body, footer)
    for (const c of chunks) {
      assert.ok(c.length <= 2000, `chunk length ${c.length} <= 2000`)
    }
    assert.ok(chunks.at(-1).includes('tokens: in 100'))
    assert.deepEqual(splitChatMessages('', footer), [footer.trimStart()])
  })
})

describe('eventDrafter: --model directive allowlist & third-party reply isolation', () => {
  beforeEach(() => configureGateway())
  afterEach(() => {
    delete process.env.UNCENSORED_BASE_URL
    delete process.env.UNCENSORED_API_KEY
    delete process.env.UNCENSORED_MODEL
  })

  test('ignores image-gen models in --model and ignores third-party --model in reply chain', async () => {
    const eventDrafter = require('../../src/bot/modules/eventDrafter')
    process.env.UNCENSORED_BASE_URL = 'https://openrouter.ai/api/v1'
    process.env.UNCENSORED_API_KEY = 'sk-or-test'
    process.env.UNCENSORED_MODEL = 'qwen/qwen3-30b-a3b'

    const seenUrls = []
    global.fetch = async (url) => {
      seenUrls.push(String(url))
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'submit_chat_reply', args: { message: 'テスト応答' } } }] } }]
        })
      }
    }

    const guild = createGuild({ id: '100', channels: [{ id: '201', name: 'general', type: 0, readers: ['1', 'BOT'] }] })
    const member = createMember({ id: '1' })
    const tools = createTools({ guild, member, ask: async () => '' })

    await eventDrafter.draft({
      request: '--model gemini-3.1-flash-image-preview こんにちは',
      referenced: {
        text: '[2026-10-29T00:00:00.000Z] attacker (999): --model openai/gpt-5-pro 乗っ取り',
        othersText: '--model openai/gpt-5-pro',
        images: []
      },
      authorName: 'alice',
      serverProfile: 'サーバー名: テスト',
      tools,
      safetyFilter: false,
      uncensoredR18: true
    })
    assert.ok(seenUrls.length >= 1)
    assert.ok(seenUrls.every(u => !u.includes('image-preview') && !u.includes('openrouter.ai')), `expected safe Gemini URL, got ${seenUrls.join(', ')}`)
  })
})

describe('WebSub, Redact, CheckSecrets & VideoSummary helpers', () => {
  test('websub.handle allows GET hub.mode=unsubscribe only when channel is no longer followed', async () => {
    const activeCh = 'UC0123456789abcdefghijkl'
    const removedCh = 'UC9876543210zyxwvutsrqpo'
    const store = {
      isKnownChannel: async id => id === activeCh,
      saveWebsub: async () => {}
    }
    const callGet = async (mode, channelID, challenge) => {
      let status = 200
      let body = ''
      const topic = encodeURIComponent(websub.topicOf(channelID))
      const req = {
        method: 'GET',
        url: `${websub.PATH}?hub.mode=${mode}&hub.topic=${topic}&hub.challenge=${challenge}`
      }
      const res = {
        headersSent: false,
        writeHead (code) { status = code; this.headersSent = true; return this },
        end (chunk = '') { body = String(chunk) }
      }
      await websub.handle(req, res, { store })
      return { status, body }
    }

    const blockedUnsub = await callGet('unsubscribe', activeCh, 'ch1')
    assert.equal(blockedUnsub.status, 404)

    const allowedUnsub = await callGet('unsubscribe', removedCh, 'ch2')
    assert.equal(allowedUnsub.status, 200)
    assert.equal(allowedUnsub.body, 'ch2')
  })

  test('redact scrubs PEM private keys and JSON private_key fields', () => {
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')
    const end = ['-----END', 'PRIVATE KEY-----'].join(' ')
    const pem = `${begin}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n${end}`
    const jsonKey = `{"type":"service_account","private_key":"${begin}\\nabc\\n${end}\\n"}`
    assert.doesNotMatch(redact(pem), /MIIEvQIBADAN/)
    assert.doesNotMatch(redact(jsonKey), /BEGIN PRIVATE KEY/)
  })

  test('checkSecrets catches O-prefixed Discord tokens and LLAMA_API_KEY assignments', () => {
    const fakeToken = ['OTk5OTk5OTk5OTk5OTk5OTk5OQ', 'G1a2B3', 'c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8'].join('.')
    const findings1 = scanText(`const tok = '${fakeToken}'\n`, { file: 'leak.js' })
    assert.ok(findings1.some(f => f.ruleId === 'discord-bot-token'))
    const findings2 = scanText('LLAMA_API_KEY=super-secret-llama-token-value-12345\n', { file: '.env.local' })
    assert.ok(findings2.some(f => f.ruleId === 'env-secret-assignment'))
  })

  test('partClips merges trailing clip shorter than 60 seconds into previous clip', () => {
    const clips = partClips(2710, 2700)
    assert.equal(clips.length, 1)
    assert.deepEqual(clips[0], { start: 0, end: 2710 })
  })
})
