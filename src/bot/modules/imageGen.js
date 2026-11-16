// Makes a cover image with Gemini's image model, from the draft's title and description and, when
// there is one, the image the model picked (which the new image is based on).
const prompts = require('../utils/prompts')
const { callGemini, GeminiError } = require('./eventDrafter')
const { cropTo, SIZES } = require('../utils/imageCrop')

const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'

// The supported ratio closest to each target size; the result is cropped to the exact size after.
const ASPECT_RATIOS = new Map([[SIZES.eventCover, '21:9'], [SIZES.forumImage, '16:9']])

function buildPrompt ({ title, summary, hasSource }) {
  return prompts.render('image/cover', { title, summary: summary ? summary.slice(0, 500) : '', hasSource: !!hasSource })
}

// The requester's own words about the image ("背景を夜空に", "もっと明るく"): the current image is
// edited as told, or, without one, a new image is made to match.
function buildEditPrompt ({ title, summary, instruction, hasSource }) {
  return prompts.render('image/edit', { title, summary: summary ? summary.slice(0, 500) : '', instruction: instruction.slice(0, 500), hasSource: !!hasSource })
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
  }, { purpose: 'image' })
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

// The aspect ratios a picture asked for in chat may have (generate_image in eventTools.js).
const CHAT_ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4']

// A picture asked for in chat, as the model described it, made from `sources` (images to base it
// on or edit, as JPEG or PNG buffers) when there are any. Resolves to { buffer, mimeType }, as
// the image model made it (not cropped).
async function generateImage ({ description, sources = [], aspectRatio = '1:1' }) {
  const parts = [{ text: prompts.render('image/chat', { description: String(description).slice(0, 2000), hasSource: sources.length !== 0 }) }]
  for (const source of sources) parts.push({ inlineData: { mimeType: source.mimeType || 'image/png', data: source.buffer.toString('base64') } })
  const content = await callGemini(process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: { aspectRatio: CHAT_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : '1:1' }
    }
  }, { purpose: 'image' })
  const image = content.parts.map(p => p.inlineData || p.inline_data).find(d => /^image\//.test(d?.mimeType || d?.mime_type || ''))
  if (!image) throw new GeminiError(`Gemini returned no image: ${JSON.stringify(content).slice(0, 500)}`, 'AI が画像を作れませんでした')
  return { buffer: Buffer.from(image.data, 'base64'), mimeType: image.mimeType || image.mime_type }
}

module.exports = { generateCover, editCover, generateImage, buildPrompt, buildEditPrompt, CHAT_ASPECT_RATIOS }
