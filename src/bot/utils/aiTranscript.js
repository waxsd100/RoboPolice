// Everything sent to an AI model while one mention is handled, and what came back, for the mention
// log (mention_logs.ai_transcript): so why a request was refused or answered as it was can be
// looked at afterwards. Kept with the mention's usage (geminiUsage.js), so every call made for it,
// wherever, is recorded.
//
// { systems: { <hash>: text }, calls: [{ at, model, purpose, system, cachedContent, tools,
//   safetySettings, generationConfig, fromTurn, turns, response, error }] }
// A call's conversation is stored as what is new since the call before (`turns` from `fromTurn`),
// and each set of system instructions once (`systems`). Pictures are left out (their type and
// size are kept), and so are thought signatures; long texts are cut to MAX_TEXT.
const crypto = require('crypto')
const { currentUsage } = require('./geminiUsage')

const MAX_TEXT = 20000
const MAX_CALLS = 60

const hashOf = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
const cut = text => typeof text === 'string' && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…（${text.length - MAX_TEXT}文字省略）` : text

function slimPart (part) {
  if (!part || typeof part !== 'object') return part
  const out = {}
  for (const [key, value] of Object.entries(part)) {
    if (key === 'thoughtSignature' || key === 'thought_signature') continue
    if (key === 'inlineData' || key === 'inline_data') {
      out.picture = { mimeType: value?.mimeType || value?.mime_type, bytes: Math.floor(String(value?.data || '').length * 3 / 4) }
    } else if (key === 'functionResponse') {
      out.functionResponse = { name: value?.name, response: JSON.parse(cut(JSON.stringify(value?.response ?? null)) || 'null') }
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
  if (!usage.transcript) usage.transcript = { systems: {}, calls: [], lastTurns: [] }
  return usage.transcript
}

// What is new in `turns` since the turns of the call before: { fromTurn, turns }.
function delta (t, turns) {
  const serialized = turns.map(turn => JSON.stringify(turn))
  let same = 0
  while (same < serialized.length && same < t.lastTurns.length && serialized[same] === t.lastTurns[same]) same++
  t.lastTurns = serialized
  return { fromTurn: same, turns: turns.slice(same) }
}

function systemRef (t, text) {
  if (typeof text !== 'string' || !text) return null
  const key = hashOf(text)
  t.systems[key] = cut(text)
  return key
}

// A call to Gemini: the body as sent (`system`: the system instructions' text, when they are in a
// cache and not in the body), and the response (or the error).
function recordGemini ({ model, purpose = '', body = {}, system = null, tools = null, response = null, error = null }) {
  const t = transcript()
  if (!t || t.calls.length >= MAX_CALLS) return
  const systemText = body.systemInstruction?.parts?.map(p => p.text || '').join('\n') || system
  const toolNames = (body.tools || tools || []).flatMap(set => (set.functionDeclarations || []).map(d => d.name))
  const candidate = response?.candidates?.[0]
  t.calls.push({
    at: new Date().toISOString(),
    model,
    purpose,
    system: systemRef(t, systemText),
    cachedContent: body.cachedContent || null,
    tools: toolNames.length ? toolNames : null,
    safetySettings: body.safetySettings || null,
    generationConfig: body.generationConfig || null,
    ...delta(t, (body.contents || []).map(slimTurn)),
    response: response
      ? {
          finishReason: candidate?.finishReason || null,
          blockReason: response.promptFeedback?.blockReason || null,
          safetyRatings: candidate?.safetyRatings || response.promptFeedback?.safetyRatings || null,
          parts: (candidate?.content?.parts || []).map(slimPart),
          usage: response.usageMetadata || null
        }
      : null,
    error: error ? String(error.message || error).slice(0, 2000) : null
  })
}

// A call to the uncensored model (OpenAI-style messages).
function recordUncensored ({ model, messages = [], tools = null, response = null, error = null }) {
  const t = transcript()
  if (!t || t.calls.length >= MAX_CALLS) return
  const [first, ...rest] = messages
  const system = first?.role === 'system' ? first.content : null
  t.calls.push({
    at: new Date().toISOString(),
    model,
    purpose: 'uncensored',
    system: systemRef(t, typeof system === 'string' ? system : null),
    tools: tools ? tools.map(d => d.function?.name || d.name).filter(Boolean) : null,
    ...delta(t, (system ? rest : messages).map(slimMessage)),
    response: response ? { message: slimMessage(response) } : null,
    error: error ? String(error.message || error).slice(0, 2000) : null
  })
}

// The transcript of the mention being handled, for the mention log, or null.
function forLog (usage) {
  const t = usage?.transcript
  if (!t?.calls?.length) return null
  return { systems: t.systems, calls: t.calls }
}

module.exports = { recordGemini, recordUncensored, forLog, slimPart, MAX_TEXT }
