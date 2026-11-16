// The uncensored image model (imagegen/server.py, or any AUTOMATIC1111 / Forge web API) for
// pictures asked for in age-restricted channels (generate_image in eventTools.js).
//   UNCENSORED_IMAGE_API_URL   its base URL, e.g. https://imagegen-xxxx.a.run.app
//   UNCENSORED_IMAGE_API_KEY   sent as "Authorization: Bearer <key>" when set
//   UNCENSORED_IMAGE_TIMEOUT_MS   how long to wait for a picture (default 6 minutes: a cold
//                                 start on Cloud Run GPU loads the model first)
// A prompt that says a child is refused here (and again by the server), and every request carries
// a short negative prompt against one.

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000

// The same words as imagegen/server.py MINOR: only words that say a child, so an adult picture is
// not refused for an anime look (少女, teen, school uniform…) or a word inside another (json).
const MINOR = new RegExp(
  '\\b(?:child|children|kid|kids|underage|toddler|infant|loli|lolis|lolicon|shota|shotacon|schoolgirl|schoolboy|' +
  'elementary school|middle school|junior high|(?:[1-9]|1[0-7])\\s*(?:yo|y/o|years? old))\\b' +
  '|(?<!\\d)(?:[1-9]|1[0-7])\\s*(?:歳|才)' +
  '|幼女|幼児|園児|児童|女児|男児|小学生|中学生|女子高生|男子高生|ロリ|ショタ|未成年' +
  '|(?<![a-z])(?:js|jc|jk)(?![a-z])',
  'i'
)
// Kept short, as a long negative prompt changes the picture too: only what keeps a child out, and
// the usual quality terms.
const NEGATIVE = 'child, loli, shota, lowres, bad anatomy, bad hands, worst quality, low quality, jpeg artifacts, watermark'

// SDXL sizes for the aspect ratios generate_image offers.
const SIZES = { '1:1': [1024, 1024], '16:9': [1344, 768], '9:16': [768, 1344], '4:3': [1152, 896], '3:4': [896, 1152] }

function baseUrl () {
  const raw = String(process.env.UNCENSORED_IMAGE_API_URL || '').trim().replace(/\/+$/, '').replace(/\/sdapi\/v1(?:\/.*)?$/, '')
  return raw || null
}

const isConfigured = () => !!baseUrl()

function timeoutMs () {
  const n = Number(process.env.UNCENSORED_IMAGE_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

const readsAsMinor = (...texts) => texts.some(t => MINOR.test(String(t || '')))

// A picture from the uncensored model: `prompt` (English tags, as the model wrote them),
// `sources` ([{ buffer }]: the first one is the image to start from), `aspectRatio`. Resolves to
// { buffer, mimeType }.
async function generate ({ prompt, sources = [], aspectRatio = '1:1' }) {
  const url = baseUrl()
  if (!url) throw new Error('検閲なしの画像モデルが設定されていません')
  if (readsAsMinor(prompt)) throw new Error('子ども・未成年に見える人物の画像は作れません')
  const [width, height] = SIZES[aspectRatio] || SIZES['1:1']
  const body = {
    prompt: String(prompt).slice(0, 1500),
    negative_prompt: NEGATIVE,
    width,
    height,
    steps: 28,
    cfg_scale: 6,
    seed: -1,
    ...(sources.length ? { init_images: [sources[0].buffer.toString('base64')], denoising_strength: 0.6 } : {})
  }
  const res = await fetch(`${url}/sdapi/v1/${sources.length ? 'img2img' : 'txt2img'}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.UNCENSORED_IMAGE_API_KEY ? { Authorization: `Bearer ${process.env.UNCENSORED_IMAGE_API_KEY}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs())
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    global.logger?.warn(`[IMAGE]: The uncensored image model returned HTTP ${res.status}: ${text.slice(0, 300)}`)
    throw new Error(res.status === 400 && /child/i.test(text) ? '子ども・未成年に見える人物の画像は作れません' : `検閲なしの画像モデルが画像を作れませんでした（HTTP ${res.status}）`)
  }
  const data = await res.json()
  const image = Array.isArray(data?.images) ? data.images[0] : null
  if (!image) throw new Error('検閲なしの画像モデルが画像を返しませんでした')
  return { buffer: Buffer.from(String(image).split(',').pop(), 'base64'), mimeType: 'image/png' }
}

module.exports = { generate, isConfigured, readsAsMinor, SIZES, NEGATIVE }
