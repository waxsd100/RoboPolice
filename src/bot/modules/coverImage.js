// The image for one draft: where it came from, how it is turned into the cover (cropped, shown
// whole, made by AI, or none), and the rendered result for each mode already tried, so switching
// back and forth in the preview does not redo work.
const urlFetcher = require('../utils/urlFetcher')
const { cropTo, fitWithBlur, defaultMode, forReference } = require('../utils/imageCrop')
const { generateCover } = require('./imageGen')

const MODES = {
  crop: '切り抜き',
  fit: '全体表示',
  ai: 'AIで作成',
  none: 'なし'
}

class CoverImage {
  constructor (size) {
    this.size = size
    this.sourceUrl = null
    this.source = null
    this.mode = 'none'
    this.rendered = new Map()
    this.note = null
  }

  // Called with every new draft (first one and each correction).
  async useDraft ({ imageUrl, title, summary }) {
    const textChanged = title !== this.title || summary !== this.summary
    this.title = title
    this.summary = summary
    this.note = null
    // The AI image is made from the text, so it is stale once the text changes.
    if (textChanged) this.rendered.delete('ai')
    if (imageUrl === this.sourceUrl) return this.mode === 'ai' ? this.select('ai') : undefined

    this.sourceUrl = imageUrl
    this.source = null
    this.rendered.clear()
    this.mode = 'none'
    if (!imageUrl) return
    try {
      this.source = (await urlFetcher.fetchImage(imageUrl)).buffer
      await this.select(await defaultMode(this.source, this.size))
    } catch (e) {
      this.source = null
      this.note = `元の画像を使えませんでした: ${e.message}`
    }
  }

  // Cropping and showing whole need a source image; the AI can also start from the text alone.
  modes () {
    return this.source ? ['crop', 'fit', 'ai', 'none'] : ['ai', 'none']
  }

  // Switches to `mode`, rendering it if needed. A failure keeps the previous mode and says why.
  async select (mode) {
    const previous = this.mode
    this.mode = mode
    this.note = null
    if (mode === 'none' || this.rendered.has(mode)) return
    try {
      this.rendered.set(mode, await this.render(mode))
    } catch (e) {
      this.mode = previous
      this.note = `${MODES[mode]}に失敗しました: ${e.hint || e.message}`
    }
  }

  render (mode) {
    if (mode === 'crop') return cropTo(this.source, this.size)
    if (mode === 'fit') return fitWithBlur(this.source, this.size)
    return (this.source ? forReference(this.source) : Promise.resolve(null))
      .then(reference => generateCover({ title: this.title, summary: this.summary, source: reference, size: this.size }))
  }

  get buffer () {
    return this.mode === 'none' ? null : this.rendered.get(this.mode) || null
  }

  describe () {
    const lines = [this.buffer ? `${MODES[this.mode]}（${this.size.width}×${this.size.height}）` : 'なし']
    if (this.note) lines.push(this.note)
    return lines.join('\n')
  }
}

module.exports = { CoverImage, MODES }
