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

// The requester's own words about the image ("背景を夜空に", "もっと明るく"): the current image is
// edited as told, or, without one, a new image is made to match.
function buildEditPrompt ({ title, summary, instruction, hasSource }) {
  return [
    hasSource
      ? 'Edit the attached image, which is the wide banner cover of a Discord community post, exactly as instructed below. Change only what the instruction asks and keep the rest.'
      : `Create a wide banner image to be used as the cover of a Discord community post titled "${title}", following the instruction below.`,
    summary ? `What the post is about: ${summary.slice(0, 500)}` : '',
    `Instruction (from the requester, may be in Japanese): ${instruction.slice(0, 500)}`,
    // Image models misspell text, often badly in Japanese, so text is drawn only when asked for.
    'Do not add any text, letters, logos or watermarks unless the instruction asks for them.'
  ].filter(Boolean).join('\n')
}

async function callImageModel (prompt, source, size) {
  const parts = [{ text: prompt }]
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

function generateCover ({ title, summary, source, size }) {
  return callImageModel(buildPrompt({ title, summary, hasSource: !!source }), source, size)
}

function editCover ({ title, summary, instruction, source, size }) {
  return callImageModel(buildEditPrompt({ title, summary, instruction, hasSource: !!source }), source, size)
}

module.exports = { generateCover, editCover, buildPrompt, buildEditPrompt }
