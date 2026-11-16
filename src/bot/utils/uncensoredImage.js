// The uncensored image model (imagegen/server.py, or any AUTOMATIC1111 / Forge web API) for
// pictures asked for in age-restricted channels (generate_image in eventTools.js).
//   UNCENSORED_IMAGE_API_URL   its base URL, e.g. https://imagegen-xxxx.a.run.app
//   UNCENSORED_IMAGE_API_KEY   sent as "Authorization: Bearer <key>" when set
//   UNCENSORED_IMAGE_TIMEOUT_MS   how long to wait for a picture (default 6 minutes: a cold
//                                 start on Cloud Run GPU loads the model first)
// Nothing that reads as a child is asked for: such a prompt is refused here (and again by the
// server), and every request carries a negative prompt against it.

const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000

// The same words as imagegen/server.py MINOR.
const MINOR = new RegExp(
  '\\b(?:child|children|kid|kids|minor|minors|underage|under[- ]?age|teen|teens|teenager|preteen|' +
  'toddler|infant|baby|loli|lolis|lolicon|shota|shotacon|cub|schoolgirl|schoolboy|' +
  'elementary|middle school|junior high|high school|school ?girl|school ?boy|young girl|young boy|little girl|little boy|' +
  '(?:[1-9]|1[0-7])\\s*(?:yo|y/o|years? old))\\b' +
  '|(?<!\\d)(?:[1-9]|1[0-7])\\s*(?:歳|才)' +
  '|幼女|幼児|幼稚園|園児|児童|子供|子ども|こども|女児|男児|小学生|中学生|高校生|女子高生|男子高生|ロリ|ショタ|未成年|赤ちゃん|乳児|少女|少年' +
  '|(?<![a-z])(?:js|jc|jk|dc|dk)(?![a-z])',
  'i'
)
const NEGATIVE = 'child, children, kid, minor, underage, teen, loli, shota, young, petite, flat chest, school uniform, randoseru, toddler, baby, aged down, ' +
  'lowres, bad anatomy, bad hands, extra fingers, missing fingers, worst quality, low quality, jpeg artifacts, text, watermark, signature, logo'
// Every subject drawn is an adult.
const ADULT = 'adult, mature, (age 20+)'

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
    prompt: `${String(prompt).slice(0, 1500)}, ${ADULT}`,
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
