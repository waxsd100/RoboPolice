// Makes a cover image with Gemini's image model, from the draft's title and description and, when
// there is one, the image the model picked (which the new image is based on).
const { callGemini, GeminiError } = require('./eventDrafter')
const { cropTo, SIZES } = require('../utils/imageCrop')

const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'

// The supported ratio closest to each target size; the result is cropped to the exact size after.
const ASPECT_RATIOS = new Map([[SIZES.eventCover, '21:9'], [SIZES.forumImage, '16:9']])

function buildPrompt ({ title, summary, hasSource }) {
  return [
    `Create a wide banner image to be used as the cover of a Discord community post titled "${title}".`,
    summary ? `What it is about: ${summary.slice(0, 500)}` : '',
    hasSource
      ? 'Base it on the attached image: keep its main subject, colours and mood, and recompose or extend it naturally so it fills a wide banner. Remove any text that is in it.'
      : 'Make an attractive, clean illustration or photo-like image that fits the topic.',
    // Image models still misspell text, often badly in Japanese; the title is shown next to the
    // image anyway.
    'Do not draw any text, letters, numbers, logos or watermarks.'
  ].filter(Boolean).join('\n')
}

async function generateCover ({ title, summary, source, size }) {
  const parts = [{ text: buildPrompt({ title, summary, hasSource: !!source }) }]
  if (source) parts.push({ inlineData: { mimeType: 'image/jpeg', data: source.toString('base64') } })
  const content = await callGemini(process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: ASPECT_RATIOS.get(size) }
    }
  })
  const image = content.parts.map(p => p.inlineData || p.inline_data).find(d => /^image\//.test(d?.mimeType || d?.mime_type || ''))
  if (!image) throw new GeminiError(`Gemini returned no image: ${JSON.stringify(content).slice(0, 500)}`, 'AI が画像を作れませんでした')
  return cropTo(Buffer.from(image.data, 'base64'), size)
}

module.exports = { generateCover, buildPrompt }
