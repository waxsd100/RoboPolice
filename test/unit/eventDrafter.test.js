const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { draft, revise, toScheduledEvent, isConfigured, ENTITY_TYPES } = require('../../src/bot/modules/eventDrafter')
const { createGuild, configureGateway, installGemini, call, submit, lastToolResponses } = require('../helpers/fakes')

const NOW = new Date('2026-10-29T15:00:00+09:00')
const guild = createGuild({
  channels: [
    { id: '201', name: 'general', type: 0 },
    { id: '202', name: 'ボイス', type: 2 },
    { id: '203', name: 'ステージ', type: 13 }
  ]
})

describe('toScheduledEvent', () => {
  const base = { found: true, name: '交流会', start: '2026-11-03T19:00:00+09:00', end: '2026-11-03T21:00:00+09:00' }

  test('builds an external event in UTC', () => {
    const { event, endGuessed } = toScheduledEvent({ ...base, location_type: 'external', location: '渋谷' }, guild, NOW)
    assert.deepEqual(event, {
      name: '交流会',
      privacy_level: 2,
      scheduled_start_time: '2026-11-03T10:00:00.000Z',
      scheduled_end_time: '2026-11-03T12:00:00.000Z',
      description: undefined,
      entity_type: ENTITY_TYPES.external,
      entity_metadata: { location: '渋谷' }
    })
    assert.equal(endGuessed, false)
  })

  test('uses a voice channel', () => {
    const { event } = toScheduledEvent({ ...base, location_type: 'voice', channel_id: '202' }, guild, NOW)
    assert.equal(event.entity_type, ENTITY_TYPES.voice)
    assert.equal(event.channel_id, '202')
    assert.equal(event.entity_metadata, undefined)
  })

  test('uses the channel type, not the claimed one, for stage channels', () => {
    const { event } = toScheduledEvent({ ...base, location_type: 'voice', channel_id: '203' }, guild, NOW)
    assert.equal(event.entity_type, ENTITY_TYPES.stage)
  })

  test('falls back to external for a missing channel', () => {
    const { event } = toScheduledEvent({ ...base, location_type: 'voice', channel_id: '999' }, guild, NOW)
    assert.equal(event.entity_type, ENTITY_TYPES.external)
    assert.equal(event.entity_metadata.location, '未定')
  })

  test('falls back to external for a text channel', () => {
    const { event } = toScheduledEvent({ ...base, location_type: 'voice', channel_id: '201', location: 'どこか' }, guild, NOW)
    assert.equal(event.entity_type, ENTITY_TYPES.external)
    assert.equal(event.entity_metadata.location, 'どこか')
  })

  test('guesses a one hour end when it is missing', () => {
    const { event, endGuessed } = toScheduledEvent({ ...base, end: '' }, guild, NOW)
    assert.equal(event.scheduled_end_time, '2026-11-03T11:00:00.000Z')
    assert.equal(endGuessed, true)
  })

  test('guesses the end when it is not after the start', () => {
    const { endGuessed } = toScheduledEvent({ ...base, end: base.start }, guild, NOW)
    assert.equal(endGuessed, true)
  })

  test('truncates fields to Discord limits', () => {
    const { event } = toScheduledEvent({ ...base, name: 'n'.repeat(150), description: 'd'.repeat(1500), location: 'l'.repeat(150) }, guild, NOW)
    assert.equal(event.name.length, 100)
    assert.equal(event.description.length, 1000)
    assert.equal(event.entity_metadata.location.length, 100)
  })

  test('passes through the model reason when nothing was found', () => {
    assert.deepEqual(toScheduledEvent({ found: false, reason: '日時がありません' }, guild, NOW), { error: '日時がありません' })
  })

  test('an edited event may keep a start time that has passed, but not move to one', () => {
    const past = '2026-01-01T10:00:00.000Z'
    assert.ok(toScheduledEvent({ ...base, start: past }, guild, NOW, { keepStart: new Date(past) }).event)
    assert.match(toScheduledEvent({ ...base, start: '2026-01-01T11:00:00.000Z' }, guild, NOW, { keepStart: new Date(past) }).error, /過去/)
  })

  test('carries valid image candidates and drops anything else', () => {
    assert.deepEqual(toScheduledEvent({ ...base, image_urls: ['https://e.com/cover.jpg', 'javascript:x', 'https://e.com/b.png'] }, guild, NOW).imageUrls, ['https://e.com/cover.jpg', 'https://e.com/b.png'])
    assert.deepEqual(toScheduledEvent(base, guild, NOW).imageUrls, [])
  })

  test('rejects a missing name', () => {
    assert.match(toScheduledEvent({ ...base, name: '  ' }, guild, NOW).error, /イベント名/)
  })

  test('rejects an unparseable start', () => {
    assert.match(toScheduledEvent({ ...base, start: '来週' }, guild, NOW).error, /開始日時を読み取れません/)
  })

  test('rejects a start in the past', () => {
    assert.match(toScheduledEvent({ ...base, start: '2026-10-01T19:00:00+09:00' }, guild, NOW).error, /過去/)
  })
})

describe('isConfigured', () => {
  test('needs both the account and the gateway', () => {
    configureGateway()
    assert.equal(isConfigured(), true)
    delete process.env.CLOUDFLARE_AI_GATEWAY_ID
    assert.equal(isConfigured(), false)
  })
})

describe('draft', () => {
  let toolCalls
  const tools = {
    declarations: [{ name: 'lookup', description: 'x' }],
    sources: [],
    async call (name, args) {
      toolCalls.push({ name, args })
      return { result: `${name} result` }
    }
  }
  beforeEach(() => {
    configureGateway()
    toolCalls = []
  })

  test('submits directly when no lookup is needed', async () => {
    installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    const result = await draft({ request: 'A', channelName: 'general', guild, tools, now: NOW })
    assert.equal(result.kind, 'event')
    assert.equal(result.event.name, 'A')
  })

  test('sends the gateway URL, keys and tool setup', async () => {
    process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'gw-token'
    process.env.GEMINI_MODEL = 'gemini-test'
    const requests = installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    await draft({ request: 'A', channelName: 'general', guild, tools, now: NOW })
    const [{ url, headers, body }] = requests
    assert.equal(url, 'https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models/gemini-test:generateContent')
    assert.equal(headers['x-goog-api-key'], 'gemini-key')
    assert.equal(headers['cf-aig-authorization'], 'Bearer gw-token')
    assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY')
    assert.equal(requests[0].dispatcher, undefined, 'ordinary calls keep fetch\'s default limits')
    assert.deepEqual(body.tools[0].functionDeclarations.map(d => d.name), ['lookup', 'submit_event_draft', 'submit_forum_post_draft', 'submit_chat_reply'])
  })

  test('answers talk that is not a request with a chat reply, in the community\'s character', async () => {
    const requests = installGemini([[call('submit_chat_reply', { text: '  こんにちは！  ' })]])
    const result = await draft({ request: 'こんにちは', channelName: 'general', guild, tools, now: NOW })
    assert.equal(result.kind, 'chat')
    assert.equal(result.text, 'こんにちは！')
    const instruction = requests[0].body.systemInstruction.parts[0].text
    assert.match(instruction, /頼んでいないとき（あいさつ・雑談・質問・相談など）は[\s\S]*submit_chat_reply/)
    assert.match(instruction, /頼んでいるのに[\s\S]*found: false と理由つきで提出/)
    assert.match(instruction, /## 返事をするときのキャラクター[\s\S]*配信者本人になりきって[\s\S]*なりきるのは話し方までです/)
    assert.doesNotMatch(instruction, /運営者が設定したキャラクター/)
  })

  test('adds the operator\'s character notes from CHAT_PERSONA', async () => {
    process.env.CHAT_PERSONA = '語尾は「〜だぜ」'
    try {
      const requests = installGemini([[call('submit_chat_reply', { text: 'よろしくだぜ' })]])
      await draft({ request: 'よろしく', channelName: 'general', guild, tools, now: NOW })
      assert.match(requests[0].body.systemInstruction.parts[0].text, /## 運営者が設定したキャラクター\n語尾は「〜だぜ」$/)
    } finally {
      delete process.env.CHAT_PERSONA
    }
  })

  test('selects the stored key by alias when one is configured', async () => {
    delete process.env.GEMINI_API_KEY
    process.env.CLOUDFLARE_AI_GATEWAY_TOKEN = 'gw-token'
    process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS = 'Gemini_API_Key'
    const requests = installGemini([[submit({ found: false })]])
    await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })
    assert.equal(requests[0].headers['cf-aig-byok-alias'], 'Gemini_API_Key')
    assert.equal(requests[0].headers['x-goog-api-key'], undefined)
  })

  test('a call can pick another stored key, and then sends no key of its own', async () => {
    process.env.GEMINI_API_KEY = 'paid-key-value'
    process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS = 'Gemini_API_Key'
    const requests = installGemini([[{ text: 'ok' }]])
    await require('../../src/bot/modules/eventDrafter').callGemini('m', { contents: [] }, { byokAlias: 'free-key' })
    assert.equal(requests[0].headers['cf-aig-byok-alias'], 'free-key')
    assert.equal(requests[0].headers['x-goog-api-key'], undefined)
    delete process.env.CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS
  })

  test('omits optional headers and uses the default model', async () => {
    delete process.env.GEMINI_API_KEY
    const requests = installGemini([[submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })]])
    await draft({ request: 'A', channelName: 'general', guild, tools, now: NOW })
    assert.match(requests[0].url, /models\/gemini-flash-latest:generateContent$/)
    assert.equal(requests[0].headers['x-goog-api-key'], undefined)
    assert.equal(requests[0].headers['cf-aig-authorization'], undefined)
    assert.equal(requests[0].headers['cf-aig-byok-alias'], undefined)
  })

  test('puts the time, channel, request and replied-to message in the prompt', async () => {
    const requests = installGemini([[submit({ found: false })]])
    await draft({ request: '交流会', referenced: { text: '告知文', count: 1 }, channelName: 'general', guild, tools, now: NOW })
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /現在日時: 2026年10月29日木曜日 15:00（Asia\/Tokyo）/)
    assert.match(prompt, /依頼されたチャンネル: #general/)
    assert.match(prompt, /## 依頼メッセージ\n交流会/)
    assert.match(prompt, /## 依頼メッセージの返信先\n告知文/)
  })

  test('a reply chain goes in as the conversation the request continues', async () => {
    const requests = installGemini([[call('submit_chat_reply', { text: 'x' })]])
    await draft({ request: 'それの続編は？', referenced: { text: 'me: おすすめは？\nあなた（BOT）: 〇〇！', count: 2 }, channelName: 'general', guild, tools, now: NOW })
    assert.match(requests[0].body.contents[0].parts[0].text, /## 依頼メッセージの返信先（返信をたどった会話。古い順で、最後が直接の返信先。依頼メッセージはこの続き）\nme: おすすめは？\nあなた（BOT）: 〇〇！/)
    assert.match(requests[0].body.systemInstruction.parts[0].text, /「あなた（BOT）」は、あなた自身がこれまでに送ったメッセージです。必ずその会話の続きとして/)
  })

  test('lists attached images and the named forum in the prompt', async () => {
    const requests = installGemini([[submit({ found: false })]])
    await draft({ request: 'x', channelName: 'general', forum: { id: '301', name: '募集' }, images: ['https://cdn/a.png'], guild, tools, now: NOW })
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /## 依頼メッセージの添付画像\n- https:\/\/cdn\/a\.png/)
    assert.match(prompt, /## 投稿先に指定されたフォーラム\n301: 募集/)
  })

  test('revise sends the correction as the answer to the submit call and checks the new draft', async () => {
    const requests = installGemini([
      [submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })],
      body => {
        const last = body.contents[body.contents.length - 1]
        assert.equal(last.parts[0].functionResponse.name, 'submit_event_draft')
        assert.match(last.parts[0].functionResponse.response.result, /修正を求めています[\s\S]*開始は20時/)
        return [submit({ name: 'A', start: '2026-11-03T20:00:00+09:00' })]
      }
    ])
    const first = await draft({ request: 'A', channelName: 'general', guild, tools, now: NOW })
    const second = await revise(first.conversation, '開始は20時')
    assert.equal(second.event.scheduled_start_time, '2026-11-03T11:00:00.000Z')
    assert.equal(second.conversation, first.conversation)
    // The whole history goes back: prompt, first submit, correction.
    assert.equal(requests[1].body.contents.length, 3)
  })

  test('revise answers every call of the submitting turn, not just the submit', async () => {
    const requests = installGemini([
      [call('lookup', { n: 1 }), submit({ name: 'A', start: '2026-11-03T19:00:00+09:00' })],
      [submit({ name: 'A', start: '2026-11-03T20:00:00+09:00' })]
    ])
    const first = await draft({ request: 'A', channelName: 'general', guild, tools, now: NOW })
    await revise(first.conversation, '20時に')
    const answers = requests[1].body.contents.at(-1).parts.map(p => p.functionResponse)
    assert.deepEqual(answers.map(a => a.name), ['lookup', 'submit_event_draft'])
    assert.match(answers[0].response.error, /提出と同時に呼ばれたため実行していません/)
    assert.match(answers[1].response.result, /20時に/)
  })

  test('runs tool calls in order and returns their results to the model', async () => {
    const requests = installGemini([
      [call('lookup', { n: 1 }), call('lookup', { n: 2 })],
      body => {
        assert.deepEqual(lastToolResponses(body), [
          { name: 'lookup', response: { result: 'lookup result' } },
          { name: 'lookup', response: { result: 'lookup result' } }
        ])
        return [submit({ name: 'B', start: '2026-11-03T19:00:00+09:00' })]
      }
    ])
    const result = await draft({ request: 'B', channelName: 'general', guild, tools, now: NOW })
    assert.deepEqual(toolCalls.map(c => c.args.n), [1, 2])
    assert.equal(result.event.name, 'B')
    assert.equal(requests.length, 2)
  })

  test('echoes the model turn back unchanged, including thought signatures', async () => {
    const turn = [{ thoughtSignature: 'sig', functionCall: { name: 'lookup', args: {} } }]
    const requests = installGemini([turn, [submit({ found: false })]])
    await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })
    assert.deepEqual(requests[1].body.contents[1], { role: 'model', parts: turn })
  })

  test('stops after too many steps', async () => {
    installGemini(Array.from({ length: 10 }, () => [call('lookup')]))
    const result = await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })
    assert.match(result.error, /手順が多すぎた/)
    assert.equal(toolCalls.length, 10)
  })

  test('passes the reason through when the model gives up', async () => {
    installGemini([[submit({ found: false, reason: '日時がありません' })]])
    assert.equal((await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })).error, '日時がありません')
  })

  test('routes a forum submission to the forum checks', async () => {
    installGemini([[call('submit_forum_post_draft', { found: false, reason: '投稿先が分かりません' })]])
    assert.equal((await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })).error, '投稿先が分かりません')
  })

  test('fails when the model answers without a tool call', async () => {
    installGemini([[{ text: 'hello' }]])
    await assert.rejects(draft({ request: 'x', channelName: 'general', guild, tools, now: NOW }), /without a tool call/)
  })

  test('fails on an HTTP error from the gateway, with a hint for the requester', async () => {
    installGemini([new Error('quota exceeded')])
    await assert.rejects(draft({ request: 'x', channelName: 'general', guild, tools, now: NOW }), {
      name: 'Error', message: /HTTP 500 quota exceeded/, hint: 'AI の呼び出しに失敗しました（HTTP 500）'
    })
  })

  test('sends every submit tool with a non-empty schema', async () => {
    const requests = installGemini([[submit({ found: false })]])
    await draft({ request: 'x', channelName: 'general', guild, tools, now: NOW })
    for (const d of requests[0].body.tools[0].functionDeclarations) {
      if (d.parameters) assert.ok(Object.keys(d.parameters.properties).length > 0, d.name)
    }
  })
})

describe('rate limits (HTTP 429)', () => {
  const { callGemini, retryTimer } = require('../../src/bot/modules/eventDrafter')
  const { trackUsage } = require('../../src/bot/utils/geminiUsage')
  const GATEWAY_429 = '{"success":false,"error":[{"code":2003,"message":"Rate limited"}],"name":"AiGatewayError","httpCode":429,"internalCode":2003}'

  // Answers each call with the next status; 200 answers carry a model turn.
  function scriptedFetch (statuses, { retryAfter } = {}) {
    let i = 0
    global.fetch = async () => {
      const status = statuses[i++]
      if (status === 200) return { ok: true, status, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }
      return {
        ok: false,
        status,
        headers: { get: name => (name === 'retry-after' && retryAfter) || null },
        text: async () => status === 429 ? GATEWAY_429 : 'boom'
      }
    }
    return () => i
  }

  let waits
  beforeEach((t) => {
    configureGateway()
    waits = []
    t.mock.method(retryTimer, 'sleep', async ms => { waits.push(ms) })
  })

  test('retries with 2s, 4s, 8s backoff and succeeds', async () => {
    const calls = scriptedFetch([429, 429, 429, 200])
    const content = await callGemini('m', {})
    assert.equal(content.parts[0].text, 'ok')
    assert.deepEqual(waits, [2000, 4000, 8000])
    assert.equal(calls(), 4)
  })

  test('honors Retry-After, capped at 30 seconds', async () => {
    scriptedFetch([429, 200], { retryAfter: '5' })
    await callGemini('m', {})
    assert.deepEqual(waits, [5000])
    scriptedFetch([429, 200], { retryAfter: '600' })
    await callGemini('m', {})
    assert.deepEqual(waits, [5000, 30000])
  })

  test('gives up after 3 retries and says it was the gateway\'s limit', async () => {
    const calls = scriptedFetch([429, 429, 429, 429])
    await assert.rejects(callGemini('m', {}), {
      hint: 'AI Gateway のリクエスト数の上限に達しました。Cloudflare の AI Gateway の Rate-limiting 設定を確認してください',
      message: /HTTP 429 .*AiGatewayError/
    })
    assert.equal(calls(), 4)
  })

  test('a 429 from Gemini itself is reported as Gemini\'s limit', async () => {
    global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' })
    await assert.rejects(callGemini('m', {}), { hint: 'Gemini の利用上限に達しました（HTTP 429）' })
  })

  test('other errors are not retried', async () => {
    const calls = scriptedFetch([500])
    await assert.rejects(callGemini('m', {}), { hint: 'AI の呼び出しに失敗しました（HTTP 500）' })
    assert.equal(calls(), 1)
    assert.deepEqual(waits, [])
  })

  test('requests and retries are counted for the mention being handled, and waits announced', async () => {
    scriptedFetch([429, 200, 200])
    const announced = []
    const usage = await trackUsage(async usage => {
      usage.onWait = ms => announced.push(ms)
      await callGemini('m', {})
      await callGemini('m', {})
      return usage
    })
    assert.equal(usage.requests, 3)
    assert.equal(usage.retries, 1)
    assert.deepEqual(announced, [2000])
  })

  test('outside of a mention nothing is counted', async () => {
    scriptedFetch([200])
    await callGemini('m', {})
    assert.equal(require('../../src/bot/utils/geminiUsage').currentUsage(), null)
  })
})
