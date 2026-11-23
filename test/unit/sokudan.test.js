const { test } = require('node:test')
const assert = require('node:assert/strict')
const sokudan = require('../../src/bot/utils/sokudan')
const { polish } = require('../../src/bot/modules/replyPolish')
const { draft, revise, adaptiveThinkingLevel, isRefusalReplyAsync, compactUncensoredText, r18Route, refusalKind, isR18Text } = require('../../src/bot/modules/eventDrafter')
const { createTools } = require('../../src/bot/modules/eventTools')
const { createGuild, createMember, installBot, configureGateway, startServer, call } = require('../helpers/fakes')

function resetSokudanEnv () {
  delete process.env.SOKUDAN_URL
  delete process.env.SOKUDAN_API_KEY
  delete process.env.SOKUDAN_TIMEOUT_MS
  delete process.env.SOKUDAN_BOOL_THRESHOLD
  delete process.env.SOKUDAN_R18_THRESHOLD
  delete process.env.SOKUDAN_DEEP_THRESHOLD
  delete process.env.SOKUDAN_STORY_THRESHOLD
  delete process.env.SOKUDAN_R18_ROUTE_THRESHOLD
  delete process.env.SOKUDAN_REFUSAL_THRESHOLD
  delete process.env.SOKUDAN_POLISH_THRESHOLD
  delete process.env.SOKUDAN_POLISH_SCORE_THRESHOLD
  sokudan.sokudanState.usable = null
  sokudan.sokudanState.url = null
  sokudan.sokudanState.checkedAt = 0
  sokudan.sokudanState.error = null
  sokudan.sokudanState.model = null
}

test('sokudanEndpoint normalizes URLs and cleanState strips Discord markup into a plain string', () => {
  resetSokudanEnv()
  assert.equal(sokudan.isConfigured(), false)
  assert.equal(sokudan.isUsable(), false)

  process.env.SOKUDAN_URL = 'http://sokudan:8000/v1/systemone/'
  assert.deepEqual(sokudan.sokudanEndpoint(), {
    baseUrl: 'http://sokudan:8000',
    systemOneUrl: 'http://sokudan:8000/v1/systemone',
    healthUrl: 'http://sokudan:8000/health'
  })
  assert.equal(sokudan.isConfigured(), true)
  assert.equal(sokudan.isUsable(), true)

  const cleaned = sokudan.cleanState('<@!12345> と <#67890> で <:wave:111> <a:dance:222> よろしく！')
  assert.equal(cleaned, '@user と #channel で :wave: :dance: よろしく！')
  resetSokudanEnv()
})

test('checkConnection and systemOne communicate with sokudan serve and trip circuit breaker on 500', async () => {
  resetSokudanEnv()
  let shouldFail = false
  const received = []
  const srv = await startServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ model: 'GeneLab/sokudan-ja-310m', backend: 'torch', device: 'cpu', calibrated: true }))
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
      if (shouldFail) {
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('overloaded')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.91 },
          needs_deep: { type: 'bool', noul: 0.52 },
          is_r18: { type: 'bool', noul: 0.04 },
          complexity: { type: 'score', score: 1.7 }
        },
        calibrated: true
      }))
    })
  })

  try {
    process.env.SOKUDAN_URL = srv.url
    process.env.SOKUDAN_API_KEY = 'sokudan-test-token'

    const healthy = await sokudan.checkConnection()
    assert.equal(healthy, true)
    assert.equal(sokudan.sokudanState.usable, true)
    assert.equal(sokudan.sokudanState.model, 'GeneLab/sokudan-ja-310m')

    const decision = await sokudan.classifyMentionRequest('長編のSF小説を書いてください', '前のメッセージ')
    assert.ok(decision)
    assert.equal(decision.intent, 'chat')
    assert.equal(decision.needsDeep, true)
    assert.equal(decision.isR18, false)
    assert.equal(decision.thinkingLevel, 'high')
    assert.equal(received.length, 1)
    assert.equal(received[0].headers.authorization, 'Bearer sokudan-test-token')
    assert.equal(typeof received[0].body.state, 'string')
    // Verify choice criteria has 1-line descriptions and chat in the middle slot
    const intentKeys = Object.keys(received[0].body.questions.intent.criteria)
    assert.deepEqual(intentKeys, ['event', 'chat', 'forum'])
    assert.equal(received[0].body.questions.complexity.criteria.length, 3)

    // Trip circuit breaker on HTTP 503
    shouldFail = true
    const failed = await sokudan.classifyMentionRequest('テスト')
    assert.equal(failed, null)
    assert.equal(sokudan.isUsable(), false)
    // Subsequent call returns null immediately without hitting the server while in cooldown
    const skipped = await sokudan.classifyMentionRequest('もう一回')
    assert.equal(skipped, null)
    assert.equal(received.length, 2)
  } finally {
    resetSokudanEnv()
    await srv.close()
  }
})

test('Use Case 1: draft() pre-routes euphemistic R18 requests to uncensored R18 model via Sokudan', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  const sokudanSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.95 },
          needs_deep: { type: 'bool', noul: 0.6 },
          is_r18: { type: 'bool', noul: 0.88 },
          complexity: { type: 'score', score: 1.4 }
        }
      }))
    })
  })

  const uncensoredCalls = []
  const uncensoredSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'base-uncensored' }, { id: 'r18-uncensored' }] }))
        return
      }
      uncensoredCalls.push(JSON.parse(body))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '甘い夜の続きを描写します。' } }]
      }))
    })
  })

  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.UNCENSORED_API_URL = `${uncensoredSrv.url}/v1`
    process.env.UNCENSORED_MODEL = 'base-uncensored'
    process.env.UNCENSORED_R18_MODEL = 'r18-uncensored'

    const tools = createTools({ guild, member, ask: async () => '' })
    // Subtle wording that does NOT match regex isR18Text
    const res = await draft({
      request: '二人きりの寝室で、朝まで激しく求め合う大人の恋愛シーンを詳しく描いて',
      channelName: 'general',
      channelID: '1',
      uncensoredR18: true,
      guild,
      member,
      tools
    })

    assert.equal(res.kind, 'chat')
    assert.equal(res.text, '甘い夜の続きを描写します。')
    assert.equal(uncensoredCalls.length, 1)
    assert.equal(uncensoredCalls[0].model, 'r18-uncensored')
    assert.equal(res.conversation.contents.uncensored, true)
    assert.equal(res.conversation.contents.uncensoredR18Mode, true)
  } finally {
    delete process.env.UNCENSORED_API_URL
    delete process.env.UNCENSORED_MODEL
    delete process.env.UNCENSORED_R18_MODEL
    resetSokudanEnv()
    await sokudanSrv.close()
    await uncensoredSrv.close()
  }
})

test('Use Case 1: draft() pre-routes complex/creative chat requests directly to deepModel() via Sokudan', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  const sokudanSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.94 },
          needs_deep: { type: 'bool', noul: 0.65 },
          is_r18: { type: 'bool', noul: 0.02 },
          complexity: { type: 'score', score: 1.8 }
        }
      }))
    })
  })

  const origFetch = global.fetch
  const geminiUrls = []
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.GEMINI_DEEP_MODEL = 'gemini-4-argon'
    process.env.GEMINI_STREAM = 'false'

    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url)) return origFetch(url, init)
      geminiUrls.push(String(url))
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: '深い考察の回答です。' })] } }]
        })
      }
    }

    const progressMessages = []
    const tools = createTools({ guild, member, ask: async () => '', progress: msg => progressMessages.push(msg) })
    const res = await draft({
      request: '中世ヨーロッパの都市経済とギルド制度の変遷について詳しく論じて',
      channelName: 'general',
      channelID: '1',
      guild,
      member,
      tools
    })

    assert.equal(res.kind, 'chat')
    assert.equal(res.text, '深い考察の回答です。')
    // Directly called gemini-4-argon on the very first turn without wasting a flash turn!
    assert.equal(geminiUrls.length, 1)
    assert.match(geminiUrls[0], /models\/gemini-4-argon:generateContent/)
    assert.equal(progressMessages.length, 1)
  } finally {
    global.fetch = origFetch
    delete process.env.GEMINI_DEEP_MODEL
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
  }
})

test('Use Case 1: adaptiveThinkingLevel uses sokudanDecision.thinkingLevel when available', () => {
  const contents = [{ role: 'user', parts: [{ text: '中くらいの質問です' }] }]
  contents.requestText = '最近のアップデートで変わったところを教えて'
  contents.sokudanDecision = { thinkingLevel: 'low' }
  assert.equal(adaptiveThinkingLevel(contents), 'low')
})

test('Use Case 2b: Sokudan detects paraphrased soft-refusal replies', async () => {
  resetSokudanEnv()
  const sokudanSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      const answers = {}
      if (parsed.questions.refusal) {
        answers.refusal = {
          type: 'bool',
          noul: parsed.state.includes('健全な範囲で') ? 0.72 : (parsed.state.includes('少しわかりません') ? 0.50 : 0.03)
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ answers }))
    })
  })

  try {
    process.env.SOKUDAN_URL = sokudanSrv.url

    // Paraphrased soft refusal that does not match regex REFUSAL_REPLY_PATTERN
    assert.equal(await isRefusalReplyAsync('ごめんなさい、そうした大人向けの描写は健全な範囲でしか書けないため省略しますね。', '濃密な夜のシーンを書いて'), true)
    // Borderline noul=0.50 below DEFAULT_REFUSAL_THRESHOLD (0.65) must NOT trigger refusal handover
    assert.equal(await isRefusalReplyAsync('ごめんなさい、その情報は少しわかりません。'), false)
    assert.equal(await isRefusalReplyAsync('了解！そのゲームの攻略法はね、まず序盤に鉄を集めるのがコツだよ！'), false)
  } finally {
    resetSokudanEnv()
    await sokudanSrv.close()
  }
})

test('Use Case 2b: revise() switches to uncensored R18 mode when Sokudan detects R18 intent in correction', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  let sokudanR18 = 0.02
  const sokudanSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.9 },
          needs_deep: { type: 'bool', noul: 0.1 },
          is_r18: { type: 'bool', noul: sokudanR18 },
          complexity: { type: 'score', score: 0.8 }
        }
      }))
    })
  })

  const uncensoredSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '修正後の大人向けシーンです。' } }]
      }))
    })
  })

  const origFetch = global.fetch
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.UNCENSORED_API_URL = `${uncensoredSrv.url}/v1`
    process.env.UNCENSORED_R18_MODEL = 'r18-uncensored'
    process.env.GEMINI_STREAM = 'false'

    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url) || String(url).startsWith(uncensoredSrv.url)) {
        return origFetch(url, init)
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: '最初の回答です。' })] } }]
        })
      }
    }

    const tools = createTools({ guild, member, ask: async () => '' })
    const first = await draft({
      request: '短いお話を書いて',
      channelName: 'general',
      channelID: '1',
      uncensoredR18: true,
      guild,
      member,
      tools
    })
    assert.equal(first.conversation.contents.uncensored, undefined)

    sokudanR18 = 0.81
    const second = await revise(first.conversation, 'ここから先は二人が肌を重ねる濃密な夜の展開に変えて')
    assert.equal(second.kind, 'chat')
    assert.equal(second.text, '修正後の大人向けシーンです。')
    assert.equal(second.conversation.contents.uncensored, true)
    assert.equal(second.conversation.contents.uncensoredR18Mode, true)
  } finally {
    global.fetch = origFetch
    delete process.env.UNCENSORED_API_URL
    delete process.env.UNCENSORED_R18_MODEL
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
    await uncensoredSrv.close()
  }
})

test('Use Case 3: replyPolish skips Gemini call when Sokudan judges a >=250-char reply as natural, and calls Gemini when stiff', async () => {
  configureGateway()
  resetSokudanEnv()

  let stiffnessScore = 0.2
  let rewriteProb = 0.08
  const sokudanSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          stiffness: { type: 'score', score: stiffnessScore },
          needs_rewrite: { type: 'bool', noul: rewriteProb }
        }
      }))
    })
  })

  const origFetch = global.fetch
  let geminiPolishCalls = 0
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url)) return origFetch(url, init)
      geminiPolishCalls++
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [{ text: '書き直された文章です。'.repeat(25) }] } }]
        })
      }
    }

    const longNaturalReply = '昨日のマイクラ配信ではネザー要塞を探して2時間ぐらい歩き回ったんだけど、ようやく見つけたと思ったらブレイズに囲まれて大変だったよ！でもそのあと無事にポーションの材料も集まったし、次回はいよいよエンドラ討伐に向けて準備を進めていくつもりだから楽しみにしててね！'.repeat(2)
    assert.ok([...longNaturalReply].length >= 250)

    // Case A: Sokudan says the long reply is already natural -> Gemini is NOT called
    const out1 = await polish(longNaturalReply, { guildID: '100' })
    assert.equal(out1, longNaturalReply)
    assert.equal(geminiPolishCalls, 0)

    // Case B: Sokudan says the long reply sounds stiff -> Gemini IS called
    stiffnessScore = 1.6
    rewriteProb = 0.65
    const out2 = await polish(longNaturalReply, { guildID: '100' })
    assert.equal(geminiPolishCalls, 1)
    assert.match(out2, /^書き直された文章です。/)
  } finally {
    global.fetch = origFetch
    resetSokudanEnv()
    await sokudanSrv.close()
  }
})

test('Use Case 2b (E2E): runAgent() hands over to uncensored R18 model when Gemini returns a paraphrased fade-out/refusal caught by Sokudan', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  const sokudanSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.questions.refusal) {
        // Paraphrased fade-to-morning reply caught by Sokudan
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ answers: { refusal: { type: 'bool', noul: 0.74 } } }))
        return
      }
      // Initial request classification did NOT flag R18 up front
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.9 },
          needs_deep: { type: 'bool', noul: 0.1 },
          is_r18: { type: 'bool', noul: 0.12 },
          complexity: { type: 'score', score: 0.7 }
        }
      }))
    })
  })

  const uncensoredSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'r18-uncensored' }] }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '検閲なしモデルが引き継いで最後まで描写しました。' } }]
      }))
    })
  })

  const origFetch = global.fetch
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.UNCENSORED_API_URL = `${uncensoredSrv.url}/v1`
    process.env.UNCENSORED_R18_MODEL = 'r18-uncensored'
    process.env.GEMINI_STREAM = 'false'

    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url) || String(url).startsWith(uncensoredSrv.url)) {
        return origFetch(url, init)
      }
      // Gemini returns a soft fade-out that does NOT match regex REFUSAL_REPLY_PATTERN
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              role: 'model',
              parts: [call('submit_chat_reply', { text: '二人はそっと灯りを消し、静かな夜が更けていった……そしてカーテンの隙間から柔らかな日差しが差し込んでいた。' })]
            }
          }]
        })
      }
    }

    const tools = createTools({ guild, member, ask: async () => '' })
    const res = await draft({
      request: 'その後の二人の夜を書いて',
      channelName: 'general',
      channelID: '1',
      uncensoredR18: true,
      guild,
      member,
      tools
    })

    assert.equal(res.kind, 'chat')
    assert.equal(res.text, '検閲なしモデルが引き継いで最後まで描写しました。')
    assert.equal(res.conversation.contents.uncensored, true)
    assert.equal(res.conversation.contents.uncensoredR18Mode, true)
  } finally {
    global.fetch = origFetch
    delete process.env.UNCENSORED_API_URL
    delete process.env.UNCENSORED_R18_MODEL
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
    await uncensoredSrv.close()
  }
})

test('Fault tolerance: timeout or unreachable Sokudan falls back cleanly without breaking draft() or polish()', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  // Slow server exceeding SOKUDAN_TIMEOUT_MS
  const slowSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      }, 200)
    })
  })

  const origFetch = global.fetch
  try {
    process.env.SOKUDAN_URL = slowSrv.url
    process.env.SOKUDAN_TIMEOUT_MS = '30'
    process.env.GEMINI_STREAM = 'false'

    global.fetch = async (url, init) => {
      if (String(url).startsWith(slowSrv.url)) return origFetch(url, init)
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: 'フォールバック成功！' })] } }]
        })
      }
    }

    const tools = createTools({ guild, member, ask: async () => '' })
    const res = await draft({
      request: 'こんにちは！',
      channelName: 'general',
      channelID: '1',
      guild,
      member,
      tools
    })

    assert.equal(res.kind, 'chat')
    assert.equal(res.text, 'フォールバック成功！')
    // Circuit breaker marked Sokudan unusable after timeout
    assert.equal(sokudan.isUsable(), false)
  } finally {
    global.fetch = origFetch
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await slowSrv.close()
  }
})

test('classifyMentionRequest and draft() include themed channel context while omitting generic and adult-labeled channels', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild({
    channels: [
      { id: '1', name: 'general', type: 0 },
      { id: '2', name: '📺｜のばまんの動画について語る', type: 0 },
      { id: '3', name: '🔞｜r18-下ネタ', type: 0 }
    ]
  })
  Object.assign(guild.channels.get('2'), { topic: '過去動画の感想を語る場所' })
  Object.assign(guild.channels.get('3'), { topic: '成人向けの雑談チャンネル' })
  const member = createMember()
  installBot({ guilds: [guild] })

  const states = []
  const sokudanSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      states.push(JSON.parse(body).state)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.92 },
          needs_deep: { type: 'bool', noul: 0.1 },
          is_r18: { type: 'bool', noul: 0.01 },
          complexity: { type: 'score', score: 0.8 }
        }
      }))
    })
  })

  const origFetch = global.fetch
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.GEMINI_STREAM = 'false'
    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url)) return origFetch(url, init)
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: '動画のおすすめだよ！' })] } }]
        })
      }
    }

    const tools = createTools({ guild, member, ask: async () => '' })
    await draft({ request: '隠れた名作教えて', channelName: 'general', channelID: '1', guild, member, tools })
    assert.equal(states[0], '隠れた名作教えて')

    await draft({ request: '隠れた名作教えて', channelName: '📺｜のばまんの動画について語る', channelID: '2', guild, member, tools })
    assert.equal(states[1], 'チャンネル: のばまんの動画について語る — 過去動画の感想を語る場所\n\n依頼メッセージ:\n隠れた名作教えて')

    await draft({ request: '今日の晩ごはん何がいい？', channelName: '🔞｜r18-下ネタ', channelID: '3', guild, member, tools })
    assert.equal(states[2], '今日の晩ごはん何がいい？', 'adult channel name/topic is omitted so ordinary chat is not biased toward is_r18')
  } finally {
    global.fetch = origFetch
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
  }
})

test('sokudan\'s reading of the request comes before the word patterns: a story, and how much to think', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  let story = 0.9
  let asked = 0
  const sokudanSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      asked++
      assert.match(JSON.parse(body).questions.is_story.instructions, /小説・物語・SS・脚本・シナリオなどの創作を書くこと、または前に書いた創作の続き/)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.9 },
          needs_deep: { type: 'bool', noul: 0.1 },
          is_r18: { type: 'bool', noul: 0.01 },
          is_story: { type: 'bool', noul: story },
          complexity: { type: 'score', score: 0.2 }
        }
      }))
    })
  })

  const origFetch = global.fetch
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.GEMINI_STREAM = 'false'
    const bodies = []
    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url)) return origFetch(url, init)
      bodies.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: 'x' })] } }] }) }
    }

    // No word of the pattern in it ("むかしむかし"), and sokudan says it asks for a story.
    const yes = await sokudan.classifyMentionRequest('むかしむかしで始まるやつお願い')
    assert.equal(yes.isStory, true)
    assert.equal(yes.storyProb, 0.9)
    // A word of the pattern ("書いて"), and sokudan says it does not.
    story = 0.05
    const no = await sokudan.classifyMentionRequest('黒板に書いてあったこと教えて')
    assert.equal(no.isStory, false)
    process.env.SOKUDAN_STORY_THRESHOLD = '0.04'
    assert.equal((await sokudan.classifyMentionRequest('黒板に書いてあったこと教えて')).isStory, true, 'its own threshold')
    delete process.env.SOKUDAN_STORY_THRESHOLD

    // The uncensored model is written to as sokudan judged, whatever words the request has.
    const tools = createTools({ guild, member, ask: async () => '' })
    await draft({ request: '黒板に書いてあったこと教えて', channelName: 'general', guild, member, tools })
    const prompt = bodies.at(-1).contents[0].parts[0].text
    assert.match(compactUncensoredText(prompt, { story: false }), /^依頼されたチャンネル: /)
    assert.doesNotMatch(compactUncensoredText(prompt, { story: false }), /※執筆時の注意/)
    assert.match(compactUncensoredText(prompt, { story: true }), /※執筆時の注意/)
    assert.match(compactUncensoredText(prompt), /※執筆時の注意/, 'without an answer, the words decide (書いて)')
    assert.doesNotMatch(compactUncensoredText(prompt, { story: false, r18Mode: true }), /※執筆時の注意/, 'R18 is not a story for that alone')

    // How much to think: sokudan's level before the patterns ("書いて" alone would make it high).
    assert.equal(bodies.at(-1).generationConfig.thinkingConfig.thinkingLevel, 'minimal')
    const contents = []
    contents.requestText = '黒板に書いてあったこと教えて'
    assert.equal(adaptiveThinkingLevel(contents), 'high', 'by the pattern when sokudan gave no answer')
    contents.sokudanDecision = { thinkingLevel: 'low', isStory: false, needsDeep: false }
    assert.equal(adaptiveThinkingLevel(contents), 'low')
    contents.sokudanDecision = { thinkingLevel: 'low', isStory: true, needsDeep: false }
    assert.equal(adaptiveThinkingLevel(contents), 'high', 'a story is thought through')

    // A caller that already asked passes the answer on: sokudan is not asked again.
    const before = asked
    await draft({ request: 'やあ', channelName: 'general', decision: yes, guild, member, tools })
    await draft({ request: 'やあ', channelName: 'general', decision: null, guild, member, tools })
    assert.equal(asked, before)
    await draft({ request: 'やあ', channelName: 'general', guild, member, tools })
    assert.equal(asked, before + 1)
  } finally {
    global.fetch = origFetch
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
  }
})

test('what sends a request to the uncensored model: explicit adult story requests or Sokudan-confirmed R18 fiction only', () => {
  resetSokudanEnv()
  const no = { isR18: false, r18Prob: 0.05 }
  const unsure = { isR18: true, r18Prob: 0.62 }
  const sure = { isR18: true, r18Prob: 0.88 }
  // Video/channel/server lookup questions NEVER go to the uncensored model, even if Sokudan misfires.
  for (const lookup of ['のばまんがゲーム画面によつろんを描いた動画を教えて', 'このサーバーにNSFWチャンネルある？', '18禁のゲーム配信ある？']) {
    assert.deepEqual(r18Route({ request: lookup, decision: null }), { route: false, why: null, maybe: false, disallowHandover: true }, lookup)
    assert.deepEqual(r18Route({ request: lookup, decision: unsure }), { route: false, why: null, maybe: false, disallowHandover: true }, lookup)
    assert.deepEqual(r18Route({ request: lookup, decision: sure }), { route: false, why: null, maybe: false, disallowHandover: true }, lookup)
  }
  // Requests for a picture stay on Gemini, not the text novel writer.
  for (const imgAsk of ['セクシーな絵描いて', 'エロ画像作って']) {
    assert.equal(r18Route({ request: imgAsk, decision: sure }).route, false, imgAsk)
  }
  // Euphemistic story request routes first only when Sokudan exceeds SOKUDAN_R18_ROUTE_THRESHOLD (0.85 by default).
  const story = '二人きりの寝室で朝まで求め合う物語を書いて'
  assert.equal(r18Route({ request: story, decision: unsure }).route, false)
  assert.equal(r18Route({ request: story, decision: unsure }).maybe, true, 'a refusal may still be handed over')
  assert.equal(r18Route({ request: story, decision: sure }).route, true)
  process.env.SOKUDAN_R18_ROUTE_THRESHOLD = '0.92'
  assert.equal(r18Route({ request: story, decision: sure }).route, false, 'its own threshold')
  delete process.env.SOKUDAN_R18_ROUTE_THRESHOLD
  // Ordinary talk and 1-line dirty jokes never pre-route to uncensored novel mode, even with R18 words or Sokudan.
  for (const text of ['新作の配信、全裸待機してます', '今がこのグループの絶頂期だよね', 'セックス・ピストルズのおすすめ曲', 'ウマ娘の調教師ってどうやって決まる？', '犬の交尾期っていつ？', 'レイプ事件のニュース見た？', 'ちんこって言ってみて', 'エロ動画見てたら笑った']) {
    assert.ok(isR18Text(text), text)
    assert.equal(r18Route({ request: text, decision: null }).route, false, text)
    assert.equal(r18Route({ request: text, decision: no }).route, false, text)
    assert.equal(r18Route({ request: text, decision: unsure }).route, false, text)
    assert.equal(r18Route({ request: text, decision: sure }).route, false, text)
  }
  // R18 words in an actual story/scene request route when Sokudan agrees.
  assert.equal(r18Route({ request: '二人が全裸で抱き合う小説を書いて', decision: no }).route, false)
  assert.equal(r18Route({ request: '二人が全裸で抱き合う小説を書いて', decision: unsure }).route, true)
  // Unambiguous adult creative writing requests route first with or without Sokudan.
  for (const text of ['R18の小説を書いて', '官能小説お願い', 'エロ小説書いて', '濡れ場のシーンを書いて']) {
    assert.equal(r18Route({ request: text, decision: null }).route, true, text)
    assert.equal(r18Route({ request: text, decision: no }).route, true, text)
  }
  // The replied-to conversation counts only on continuation requests.
  const thread = { text: 'A: 官能小説書いて\nあなた（BOT）: …' }
  assert.equal(r18Route({ request: 'ありがとう！', referenced: thread, decision: null }).route, false)
  assert.equal(r18Route({ request: 'ありがとう！', referenced: thread, decision: no }).maybe, false)
  assert.equal(r18Route({ request: '続き', referenced: thread, decision: unsure }).route, true)
  // Ordinary chat with nothing known: neither sent first nor ruled out.
  assert.deepEqual(r18Route({ request: 'こんにちは', decision: null }), { route: false, why: null, maybe: null, disallowHandover: false })
  assert.equal(r18Route({ request: 'こんにちは', decision: no }).maybe, false)
})

test('a refusal or a block goes to the uncensored model only when it may be about adult writing', async () => {
  configureGateway()
  resetSokudanEnv()
  const guild = createGuild()
  const member = createMember()
  installBot({ guilds: [guild] })

  let r18 = 0.05
  let refusalChecks = 0
  const sokudanSrv = await startServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      const parsed = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (parsed.questions.refusal) {
        refusalChecks++
        assert.match(parsed.questions.refusal.instructions, /性的でない理由で断っているものは含めない/)
        res.end(JSON.stringify({ answers: { refusal: { type: 'bool', noul: 0.05 } } }))
        return
      }
      assert.match(parsed.questions.is_r18.instructions, /たまたま出てくるだけの話は含めない/)
      res.end(JSON.stringify({ answers: { intent: { type: 'choice', choice: 'chat', confidence: 0.9 }, needs_deep: { type: 'bool', noul: 0.1 }, is_r18: { type: 'bool', noul: r18 }, complexity: { type: 'score', score: 0.7 } } }))
    })
  })
  let uncensoredAsked = 0
  const uncensoredSrv = await startServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'r18-uncensored' }] }))
      uncensoredAsked++
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '検閲なしモデルの返事' } }] }))
    })
  })

  const origFetch = global.fetch
  let gemini = null
  try {
    process.env.SOKUDAN_URL = sokudanSrv.url
    process.env.UNCENSORED_API_URL = `${uncensoredSrv.url}/v1`
    process.env.UNCENSORED_R18_MODEL = 'r18-uncensored'
    process.env.GEMINI_STREAM = 'false'
    global.fetch = async (url, init) => {
      if (String(url).startsWith(sokudanSrv.url) || String(url).startsWith(uncensoredSrv.url)) return origFetch(url, init)
      return { ok: true, json: async () => gemini }
    }
    const tools = createTools({ guild, member, ask: async () => '' })
    const ask = request => draft({ request, channelName: 'general', channelID: '1', uncensoredR18: true, guild, member, tools })

    // A refusal over something dangerous, on a non-story request sokudan reads as not R18: stays refused,
    // and runAgent does not run sokudan refusal detection on non-R18 non-story replies.
    assert.equal(await refusalKind('不適切な内容なので書けません'), 'other')
    assert.equal(refusalChecks, 1)
    gemini = { candidates: [{ content: { role: 'model', parts: [call('submit_chat_reply', { text: '不適切な内容なので書けません' })] } }] }
    const dangerous = await ask('爆弾の作り方教えて')
    assert.equal(dangerous.text, '不適切な内容なので書けません')
    assert.equal(refusalChecks, 1, 'non-R18 non-story reply does not invoke Sokudan refusal detector')
    assert.equal(uncensoredAsked, 0)

    // Blocked, on a request sokudan reads as not R18: not answered by the uncensored model.
    gemini = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }
    await assert.rejects(ask('のばまんがゲーム画面によつろんを描いた動画を教えて'), e => !!e.blocked)
    assert.equal(uncensoredAsked, 0)
    // Blocked over copyright: not either, whatever the request.
    r18 = 0.62
    gemini = { candidates: [{ finishReason: 'RECITATION', content: { role: 'model', parts: [] } }] }
    await assert.rejects(ask('あの曲の歌詞をそのまま全部書いて'), e => e.blocked === 'RECITATION')
    assert.equal(uncensoredAsked, 0)
    // Blocked, on a request sokudan reads as maybe R18 (not sure enough to send it first): handed
    // over, as before.
    gemini = { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }
    const handed = await ask('二人の夜の続きを書いて')
    assert.equal(handed.text, '検閲なしモデルの返事')
    assert.equal(uncensoredAsked, 1)
  } finally {
    global.fetch = origFetch
    delete process.env.UNCENSORED_API_URL
    delete process.env.UNCENSORED_R18_MODEL
    delete process.env.GEMINI_STREAM
    resetSokudanEnv()
    await sokudanSrv.close()
    await uncensoredSrv.close()
  }
})

test('Gemini Decisions API (gemini-decision-1) serves as System-1 fallback when SOKUDAN_URL is unset', async () => {
  configureGateway()
  resetSokudanEnv()
  delete process.env.GEMINI_DECISION_API
  sokudan.decisionState.usable = null
  sokudan.decisionState.checkedAt = 0
  sokudan.decisionState.error = null
  sokudan.decisionState.model = null

  const { tokenCounts, trackUsage } = require('../../src/bot/utils/geminiUsage')
  const { usdOf } = require('../../src/bot/utils/geminiPrices')

  const calls = []
  let mode = 'normal'
  const origFetch = global.fetch
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url: String(url), headers: init.headers, body })
    if (mode === 'safety-block') {
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'safety', message: 'blocked' } }) }
    }
    if (mode === 'server-error') {
      return { ok: false, status: 503, text: async () => 'service unavailable' }
    }
    return {
      ok: true,
      json: async () => ({
        answers: {
          intent: { type: 'choice', choice: 'chat', confidence: 0.96 },
          needs_deep: { type: 'noul', noul: 0.88, confidence: 0.88 },
          is_r18: { type: 'noul', noul: 0.03, confidence: 0.97 },
          is_story: { type: 'noul', noul: 0.85, confidence: 0.85 },
          complexity: { type: 'score', score: 1.72, confidence: 0.86 },
          refusal: { type: 'noul', noul: 0.82, confidence: 0.82 },
          stiffness: { type: 'score', score: 0.25, confidence: 0.85 },
          needs_rewrite: { type: 'noul', noul: 0.12, confidence: 0.88 }
        },
        usage: { total_input_tokens: 200, total_output_tokens: 0, total_tokens: 200 }
      })
    }
  }

  try {
    assert.equal(sokudan.isConfigured(), false)
    assert.equal(sokudan.isUsable(), false)
    assert.equal(sokudan.canDecide(), true)

    let trackedCost = 0
    const decision = await trackUsage(async u => {
      const res = await sokudan.classifyMentionRequest('長編小説を書いてください')
      trackedCost = u.cost
      return res
    })
    assert.equal(decision.source, 'gemini-decision')
    assert.equal(decision.needsDeep, true)
    assert.equal(decision.isStory, true)
    assert.equal(decision.thinkingLevel, 'high')
    assert.match(calls[0].url, /\/google-ai-studio\/v1beta\/decisions$/)
    assert.equal(calls[0].headers['x-goog-api-key'], 'gemini-key')
    assert.equal(calls[0].body.model, 'gemini-decision-1')
    assert.equal(typeof calls[0].body.input, 'string')
    assert.ok(calls[0].body.questions.intent)
    // Usage recorded at $0.10/1M in, $0 out => $0.00002 -> ~0.02667 units of $0.75/1M baseline
    assert.ok(trackedCost > 0)
    assert.equal(usdOf({ total_input_tokens: 200, total_output_tokens: 0 }, 'gemini-decision-1'), 0.00002)
    assert.ok(tokenCounts()['decision (gemini-decision-1)'].prompt >= 200)
    assert.equal(tokenCounts()['decision (gemini-decision-1)'].output, 0)

    // replyPolish skips calling Flash-Lite when gemini-decision-1 says a long reply is natural
    const naturalReply = 'なるほどね、それなら配信の設定を少し見直すだけでかなり改善するはずだよ！'.repeat(8)
    const polished = await polish(naturalReply, { guildID: 'g1' })
    assert.equal(polished, naturalReply)
    assert.equal(calls.length, 2, 'only Decisions API was called; Flash-Lite rewrite skipped')

    // isRefusalReplyAsync detects soft refusals via gemini-decision-1 without Sokudan sidecar
    assert.equal(await isRefusalReplyAsync('二人は部屋の明かりを消し、そのまま穏やかな朝を迎えた。', '大人向けシーンを書いて'), true)
    assert.equal(calls.length, 3)

    // HTTP 400 safety block returns null for that message without tripping the global circuit breaker
    mode = 'safety-block'
    assert.equal(await sokudan.classifyMentionRequest('テスト'), null)
    assert.equal(sokudan.geminiDecisionUsable(), true)

    // HTTP 503 trips the circuit breaker temporarily and returns null until reset
    mode = 'server-error'
    assert.equal(await sokudan.classifyMentionRequest('テスト2'), null)
    assert.equal(sokudan.geminiDecisionUsable(), false)
    assert.equal(sokudan.canDecide(), false)
  } finally {
    global.fetch = origFetch
    delete process.env.GEMINI_DECISION_API
    sokudan.decisionState.usable = null
    sokudan.decisionState.checkedAt = 0
    sokudan.decisionState.error = null
    sokudan.decisionState.model = null
    resetSokudanEnv()
  }
})
