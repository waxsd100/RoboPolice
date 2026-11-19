// Everything sent to an AI model while one mention is handled, and what came back, for the mention
// log (mention_ai_calls, mention_ai_messages, mention_ai_systems): so why a request was refused or answered as it was can be
// looked at afterwards. Kept with the mention's usage (geminiUsage.js), so every call made for it,
// wherever, is recorded.
//
// { systems: { <hash>: text }, calls: [{ at, model, purpose, attempts, system, cachedContent, tools,
//   safetySettings, generationConfig, fromTurn, turns, response, error }] }
// Every call is recorded: the reply and its steps, and what is asked along the way (embeddings,
// Gemini's cache, the uncensored model, rewriting the reply); `attempts` is how many times it was
// sent (retries after HTTP 429 included), so they add up to mention_logs.gemini_calls.
// A call's conversation is stored as what is new since the call before for the same purpose
// (`turns` from `fromTurn`), and each set of system instructions once (`systems`). Pictures are left
// out (their type and size are kept), and so are thought signatures and embedding vectors; long
// texts are cut to MAX_TEXT.
const crypto = require('crypto')
const { currentUsage } = require('./geminiUsage')

const MAX_TEXT = 20000
const MAX_CALLS = 60

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
const cut = text => typeof text === 'string' && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…（${text.length - MAX_TEXT}文字省略）` : text

function slimFunctionResponse (response) {
  if (response === undefined) return null
  try {
    const serialized = JSON.stringify(response)
    if (serialized === undefined) return null
    if (serialized.length <= MAX_TEXT) return JSON.parse(serialized)
    return { _truncated: true, preview: cut(serialized) }
  } catch (_) {
    return { _truncated: true, preview: cut(String(response)) }
  }
}

function slimPart (part) {
  if (!part || typeof part !== 'object') return part
  const out = {}
  for (const [key, value] of Object.entries(part)) {
    if (key === 'thoughtSignature' || key === 'thought_signature') continue
    if (key === 'inlineData' || key === 'inline_data') {
      out.picture = { mimeType: value?.mimeType || value?.mime_type, bytes: Math.floor(String(value?.data || '').length * 3 / 4) }
    } else if (key === 'functionResponse') {
      out.functionResponse = { name: value?.name, response: slimFunctionResponse(value?.response ?? null) }
    } else {
      out[key] = typeof value === 'string' ? cut(value) : value
    }
  }
  return out
}

function slimTurn (turn) {
  if (!turn || typeof turn !== 'object') return turn
  return { role: turn.role, parts: (turn.parts || []).map(slimPart) }
}

// An OpenAI-style message (the uncensored model): its text kept, pictures left out.
function slimMessage (message) {
  const content = Array.isArray(message?.content)
    ? message.content.map(p => p?.type === 'image_url' ? { picture: true } : { text: cut(p?.text) })
    : cut(message?.content)
  return { ...message, content }
}

function transcript () {
  const usage = currentUsage()
  if (!usage) return null
  if (!usage.transcript) usage.transcript = { systems: {}, calls: [], lastTurns: {} }
  return usage.transcript
}

// Tells the mention being handled that a call was recorded (usage.onRecord), so its log is written
// as it goes.
function recorded () {
  try { currentUsage()?.onRecord?.() } catch (_) {}
}

// What is new in `turns` since the turns of the call before for the same purpose: { fromTurn, turns }.
function delta (t, purpose, turns) {
  const serialized = turns.map(turn => JSON.stringify(turn))
  const last = t.lastTurns[purpose] || []
  let same = 0
  while (same < serialized.length && same < last.length && serialized[same] === last[same]) same++
  t.lastTurns[purpose] = serialized
  return { fromTurn: same, turns: turns.slice(same) }
}

// The conversation a Gemini request sends: its contents, or the texts of an embedding request.
function sentTurns (body) {
  if (Array.isArray(body.contents)) return body.contents
  const requests = Array.isArray(body.requests) ? body.requests : body.content ? [body] : []
  return requests.map(r => ({ role: 'user', parts: r.content?.parts || [] }))
}

// What came back that is not a candidate: how many vectors (an embedding), or the cache made.
function otherAnswer (response) {
  if (Array.isArray(response.embeddings)) return [{ text: `（埋め込み ${response.embeddings.length} 件）` }]
  if (response.embedding) return [{ text: '（埋め込み 1 件）' }]
  if (typeof response.name === 'string' && response.name.startsWith('cachedContents/')) return [{ text: `（キャッシュ ${response.name}）` }]
  return []
}

function systemRef (t, text) {
  if (typeof text !== 'string' || !text) return null
  const key = hashOf(text)
  t.systems[key] = cut(text)
  return key
}

// A call to Gemini: the body as sent (`system`: the system instructions' text, when they are in a
// cache and not in the body), and the response (or the error).
function recordGemini ({ model, purpose = '', attempts = 1, body = {}, system = null, tools = null, response = null, error = null }) {
  try {
    const t = transcript()
    if (!t || t.calls.length >= MAX_CALLS) return
    const systemText = body.systemInstruction?.parts?.map(p => p.text || '').join('\n') || system
    const toolNames = (body.tools || tools || []).flatMap(set => (set.functionDeclarations || []).map(d => d.name))
    const candidate = response?.candidates?.[0]
    t.calls.push({
      at: new Date().toISOString(),
      model,
      purpose,
      attempts,
      system: systemRef(t, systemText),
      cachedContent: body.cachedContent || null,
      tools: toolNames.length ? toolNames : null,
      safetySettings: body.safetySettings || null,
      generationConfig: body.generationConfig || null,
      ...delta(t, purpose, sentTurns(body).map(slimTurn)),
      response: response
        ? {
            finishReason: candidate?.finishReason || null,
            blockReason: response.promptFeedback?.blockReason || null,
            safetyRatings: candidate?.safetyRatings || response.promptFeedback?.safetyRatings || null,
            parts: candidate ? (candidate.content?.parts || []).map(slimPart) : otherAnswer(response),
            usage: response.usageMetadata || null
          }
        : null,
      error: error ? String(error.message || error).slice(0, 2000) : null
    })
    recorded()
  } catch (e) {
    global.logger?.warn?.(`Could not record Gemini transcript: ${e.message}`)
  }
}

// A call to the uncensored model (OpenAI-style messages): the body as sent, and the response (the
// whole one: its message, why it ended and its usage) or the error.
function recordUncensored ({ model, attempts = 1, body = {}, response = null, error = null }) {
  try {
    const messages = body.messages || []
    const tools = body.tools || null
    const t = transcript()
    if (!t || t.calls.length >= MAX_CALLS) return
    const [first, ...rest] = messages
    const system = first?.role === 'system' ? first.content : null
    t.calls.push({
      at: new Date().toISOString(),
      model,
      purpose: 'uncensored',
      attempts,
      system: systemRef(t, typeof system === 'string' ? system : null),
      tools: tools ? tools.map(d => d.function?.name || d.name).filter(Boolean) : null,
      generationConfig: generationOf(body),
      ...delta(t, 'uncensored', (system ? rest : messages).map(slimMessage)),
      response: response
        ? {
            finishReason: response.choices?.[0]?.finish_reason || null,
            message: response.choices?.[0]?.message ? slimMessage(response.choices[0].message) : null,
            usage: response.usage || null
          }
        : null,
      error: error ? String(error.message || error).slice(0, 2000) : null
    })
    recorded()
  } catch (e) {
    global.logger?.warn?.(`Could not record uncensored transcript: ${e.message}`)
  }
}

// The settings an uncensored request was sent with (all but its model, messages and tools).
function generationOf (body) {
  const { model, messages, tools, ...rest } = body
  return Object.keys(rest).length ? rest : null
}

// The transcript of the mention being handled, for the mention log, or null.
function forLog (usage) {
  const t = usage?.transcript
  if (!t?.calls?.length) return null
  return { systems: { ...t.systems }, calls: [...t.calls] }
}

// One message row (mention_ai_messages) for each part of a Gemini turn, or for an OpenAI-style
// message (the uncensored model).
function messageRows (item) {
  if (Array.isArray(item?.parts)) {
    // A part with no text (one that only carried a thought signature, which is not kept) is left out.
    return item.parts.flatMap(part => {
      if (part.functionCall) return [{ role: item.role, kind: 'function_call', name: part.functionCall.name, content: JSON.stringify(part.functionCall.args ?? {}) }]
      if (part.functionResponse) return [{ role: item.role, kind: 'function_response', name: part.functionResponse.name, content: JSON.stringify(part.functionResponse.response ?? null) }]
      if (part.picture) return [{ role: item.role, kind: 'picture', name: null, content: `${part.picture.mimeType || '?'} ${part.picture.bytes ?? '?'} bytes` }]
      return part.text ? [{ role: item.role, kind: part.thought ? 'thought' : 'text', name: null, content: part.text }] : []
    })
  }
  const rows = []
  const content = Array.isArray(item?.content)
    ? item.content.map(p => p.picture ? '[画像]' : p.text).filter(Boolean).join('\n')
    : item?.content
  if (content) rows.push({ role: item.role, kind: 'text', name: item.name || null, content })
  for (const call of item?.tool_calls || []) rows.push({ role: item.role, kind: 'function_call', name: call.function?.name, content: call.function?.arguments ?? null })
  if (item?.role === 'tool' && !content) rows.push({ role: 'tool', kind: 'function_response', name: item.name || null, content: null })
  return rows
}

// The transcript as rows for mention_ai_systems, mention_ai_calls and mention_ai_messages.
function toRows (log) {
  if (!log?.calls?.length) return null
  const systems = Object.entries(log.systems || {}).map(([hash, text]) => ({ hash, text }))
  const calls = log.calls.map((call, seq) => {
    const sent = (call.turns || []).flatMap((turn, i) => messageRows(turn).map(row => ({ ...row, direction: 'sent', turn: (call.fromTurn || 0) + i })))
    const answer = call.response?.parts ? { role: 'model', parts: call.response.parts } : call.response?.message
    const received = answer ? messageRows(answer).map(row => ({ ...row, direction: 'received', turn: null })) : []
    return {
      seq,
      calledAt: call.at || new Date().toISOString(),
      model: call.model || null,
      purpose: call.purpose || null,
      attempts: call.attempts || 1,
      systemHash: call.system || null,
      cachedContent: call.cachedContent || null,
      tools: call.tools || null,
      safetySettings: call.safetySettings || null,
      generationConfig: call.generationConfig || null,
      finishReason: call.response?.finishReason || null,
      blockReason: call.response?.blockReason || null,
      safetyRatings: call.response?.safetyRatings || null,
      usage: call.response?.usage || null,
      error: call.error || null,
      messages: [...sent, ...received].map((row, i) => ({ ...row, seq: i }))
    }
  })
  return { systems, calls }
}

module.exports = { recordGemini, recordUncensored, forLog, toRows, slimPart, MAX_TEXT }
