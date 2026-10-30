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

  test('carries a valid image URL and drops anything else', () => {
    assert.equal(toScheduledEvent({ ...base, image_url: 'https://e.com/cover.jpg' }, guild, NOW).imageUrl, 'https://e.com/cover.jpg')
    assert.equal(toScheduledEvent({ ...base, image_url: 'javascript:x' }, guild, NOW).imageUrl, null)
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
    assert.deepEqual(body.tools[0].functionDeclarations.map(d => d.name), ['lookup', 'submit_event_draft', 'submit_forum_post_draft'])
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
    await draft({ request: '交流会', referenced: '告知文', channelName: 'general', guild, tools, now: NOW })
    const prompt = requests[0].body.contents[0].parts[0].text
    assert.match(prompt, /現在日時: 2026年10月29日木曜日 15:00（Asia\/Tokyo）/)
    assert.match(prompt, /依頼されたチャンネル: #general/)
    assert.match(prompt, /## 依頼メッセージ\n交流会/)
    assert.match(prompt, /## 依頼メッセージの返信先\n告知文/)
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
