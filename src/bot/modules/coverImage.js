// The image for one draft: the candidates the model proposed, which one is selected, how it is
// turned into the cover (cropped, shown whole, made by AI, or none), and every rendering already
// made, so switching back and forth in the preview does not redo work.
const urlFetcher = require('../utils/urlFetcher')
const { cropTo, fitWithBlur, defaultMode, forReference, contactSheet } = require('../utils/imageCrop')
const { generateCover } = require('./imageGen')

const MODES = {
  crop: '切り抜き',
  fit: '全体表示',
  ai: 'AIで作成',
  none: 'なし'
}

const POSITIONS = ['左上', '右上', '左下', '右下']

class CoverImage {
  constructor (size) {
    this.size = size
    this.urls = []
    this.candidates = [] // [{ url, source, defaultMode }], only the ones that could be read
    this.selected = null // index into candidates
    this.mode = 'none'
    this.rendered = new Map() // `${selected}:${mode}` (or 'ai:…') -> JPEG
    this.sheet = null
    this.readNote = null // candidates that could not be read
    this.modeNote = null // the last mode that failed to render
  }

  // Called with every new draft (first one and each correction).
  async useDraft ({ imageUrls = [], title, summary }) {
    const textChanged = title !== this.title || summary !== this.summary
    this.title = title
    this.summary = summary
    this.modeNote = null
    // AI images are made from the text, so they are stale once the text changes.
    if (textChanged) for (const key of [...this.rendered.keys()]) if (key.startsWith('ai:')) this.rendered.delete(key)
    if (imageUrls.join('\n') === this.urls.join('\n')) return this.mode === 'ai' ? this.select('ai') : undefined

    this.urls = imageUrls
    this.candidates = []
    this.rendered.clear()
    this.sheet = null
    this.selected = null
    this.mode = 'none'
    this.readNote = null
    const read = await Promise.all(imageUrls.map(async url => {
      try {
        const source = (await urlFetcher.fetchImage(url)).buffer
        return { url, source, defaultMode: await defaultMode(source, this.size) }
      } catch (e) {
        return { url, error: e.message }
      }
    }))
    this.candidates = read.filter(c => !c.error)
    const failed = read.filter(c => c.error)
    if (failed.length) this.readNote = `使えなかった画像: ${failed.map(c => c.error).join(' / ')}`
    if (this.candidates.length) {
      if (this.candidates.length > 1) this.sheet = await contactSheet(this.candidates.map(c => c.source), 0)
      await this.choose(0)
    }
  }

  // Selects candidate `index`, in the mode that suits it.
  async choose (index) {
    if (!this.candidates[index]) return
    this.selected = index
    if (this.candidates.length > 1) this.sheet = await contactSheet(this.candidates.map(c => c.source), index)
    await this.select(this.candidates[index].defaultMode)
  }

  // Cropping and showing whole need a candidate; the AI can also start from the text alone.
  modes () {
    return this.selected !== null ? ['crop', 'fit', 'ai', 'none'] : ['ai', 'none']
  }

  key (mode) {
    return `${mode === 'ai' ? 'ai' : 'c'}:${this.selected}:${mode}`
  }

  // Switches to `mode`, rendering it if needed. A failure keeps the previous mode and says why.
  async select (mode) {
    const previous = this.mode
    this.mode = mode
    this.modeNote = null
    if (mode === 'none' || this.rendered.has(this.key(mode))) return
    try {
      this.rendered.set(this.key(mode), await this.render(mode))
    } catch (e) {
      this.mode = previous
      this.modeNote = `${MODES[mode]}に失敗しました: ${e.hint || e.message}`
    }
  }

  render (mode) {
    const source = this.selected !== null ? this.candidates[this.selected].source : null
    if (mode === 'crop') return cropTo(source, this.size)
    if (mode === 'fit') return fitWithBlur(source, this.size)
    return (source ? forReference(source) : Promise.resolve(null))
      .then(reference => generateCover({ title: this.title, summary: this.summary, source: reference, size: this.size }))
  }

  get buffer () {
    return this.mode === 'none' ? null : this.rendered.get(this.key(this.mode)) || null
  }

  describe () {
    const lines = []
    if (this.buffer) {
      const which = this.candidates.length > 1 && this.mode !== 'ai' ? `画像${this.selected + 1}・` : ''
      lines.push(`${which}${MODES[this.mode]}（${this.size.width}×${this.size.height}）`)
    } else {
      lines.push('なし')
    }
    if (this.candidates.length > 1) {
      lines.push(`候補 ${this.candidates.length} 枚（下の一覧で ${this.candidates.map((_, i) => `画像${i + 1}=${POSITIONS[i]}`).join('、')}、黄色の枠が選択中）`)
    }
    if (this.modeNote) lines.push(this.modeNote)
    if (this.readNote) lines.push(this.readNote)
    return lines.join('\n')
  }
}

module.exports = { CoverImage, MODES }
