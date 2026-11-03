// What Gemini charges, in USD per million tokens on the standard tier, from the paid-tier price
// list (https://aistudio.google.com/docs/pricing, as of 2026-11-03). Flex inference and the Batch
// API cost half. A price that changes on a date is listed again with `from` (UTC).
//
// input: prompt tokens not read from a cache; cached: prompt tokens read from one (explicit or
// implicit; the storage of an explicit cache is billed by the hour and is not counted here);
// output: answer and thinking tokens; imageOutput: image tokens an image model makes.
//
// MENTION_TOKEN_PRICES adds or replaces models, as JSON in the same shape:
// {"gemini-5-flash": {"input": 1, "cached": 0.1, "output": 5}}.
const PRICES = [
  { model: 'gemini-3.8-flash', input: 0.75, cached: 0.075, output: 3.75 },
  { model: 'gemini-3.8-flash', from: '2027-01-01', input: 1.5, cached: 0.15, output: 7.5 },
  { model: 'gemini-4-argon', input: 2, cached: 0.1, output: 10 },
  { model: 'gemini-4-argon', from: '2026-12-01', input: 4, cached: 0.2, output: 20 },
  { model: 'gemini-3.5-flash-lite', input: 0.3, cached: 0.03, output: 2.5 },
  { model: 'gemini-3.1-flash-lite', input: 0.25, cached: 0.025, output: 1.5 },
  { model: 'gemini-3.1-flash-image', input: 0.5, output: 3, imageOutput: 60 },
  { model: 'gemini-3.1-flash-lite-image', input: 0.25, output: 1.5, imageOutput: 30 },
  { model: 'gemini-nano-banana-2.1', input: 1.5, output: 7.5, imageOutput: 30 }
]
// A model not in the list is priced as the usual reply model.
const FALLBACK_MODEL = 'gemini-3.8-flash'

function configuredPrices () {
  try {
    const parsed = JSON.parse(process.env.MENTION_TOKEN_PRICES || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    return {}
  }
}

const warned = new Set()

// The price of `model` at `now`: { input, cached, output, imageOutput }.
function priceOf (model, now = new Date()) {
  const configured = configuredPrices()[model]
  if (configured && Number.isFinite(Number(configured.input)) && Number.isFinite(Number(configured.output))) {
    const input = Number(configured.input)
    const output = Number(configured.output)
    return { input, cached: Number(configured.cached ?? input / 10), output, imageOutput: Number(configured.imageOutput ?? output) }
  }
  const known = PRICES.filter(p => p.model === model)
  if (!known.length && model !== FALLBACK_MODEL) {
    if (model && !warned.has(model)) {
      warned.add(model)
      global.logger?.warn(`[GEMINI]: No price listed for ${model}; counting it as ${FALLBACK_MODEL} (geminiPrices.js, MENTION_TOKEN_PRICES)`)
    }
    return priceOf(FALLBACK_MODEL, now)
  }
  const p = known.filter(p => !p.from || Date.parse(`${p.from}T00:00:00Z`) <= now.getTime()).pop()
  return { input: p.input, cached: p.cached ?? p.input / 10, output: p.output, imageOutput: p.imageOutput ?? p.output }
}

// What one response cost in USD, from its usageMetadata.
function usdOf (meta, model, { flex = false, now = new Date() } = {}) {
  if (!meta) return 0
  const price = priceOf(model, now)
  const prompt = meta.promptTokenCount || 0
  const cached = Math.min(meta.cachedContentTokenCount || 0, prompt)
  const images = (meta.candidatesTokensDetails || []).filter(d => d.modality === 'IMAGE').reduce((n, d) => n + (d.tokenCount || 0), 0)
  const text = Math.max(0, (meta.candidatesTokenCount || 0) - images) + (meta.thoughtsTokenCount || 0)
  const usd = ((prompt - cached) * price.input + cached * price.cached + text * price.output + images * price.imageOutput) / 1e6
  return flex ? usd / 2 : usd
}

module.exports = { PRICES, priceOf, usdOf, FALLBACK_MODEL }
