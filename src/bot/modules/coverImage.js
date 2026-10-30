// The image for one draft: the candidates the model proposed, which one is selected, how it is
// turned into the cover (cropped, shown whole, made by AI, kept as it is, or none), and every
// rendering already made, so switching back and forth in the preview does not redo work.
//
// Only the image buttons, and instructions about the image ("背景を夜空に", a new image to use), change
// the image. A correction of the text keeps it as it is: new candidates the model proposes are added
// to the list, but nothing is selected or redrawn for them.
const urlFetcher = require('../utils/urlFetcher')
const { cropTo, fitWithBlur, defaultMode, forReference, contactSheet } = require('../utils/imageCrop')
const { generateCover, editCover } = require('./imageGen')
const { MAX_IMAGE_CANDIDATES } = require('./forumPost')

const MODES = {
  keep: '今の画像のまま',
  crop: '切り抜き',
  fit: '全体表示',
  ai: 'AIで作成',
  edited: 'AIで編集',
  none: 'なし'
}

const POSITIONS = ['左上', '右上', '左下', '右下']

class CoverImage {
  // current: when editing something already posted that has an image, { buffer } of that image
  // (buffer null if it could not be downloaded). It is kept unless the requester picks another.
  constructor (size, { current = null } = {}) {
    this.size = size
    this.current = current
    this.candidates = [] // [{ url, source, defaultMode }], only the ones that could be read
    this.selected = null // index into candidates
    this.mode = current ? 'keep' : 'none'
    this.rendered = new Map() // key(mode) -> JPEG
    this.sheet = null
    this.readNote = null // candidates that could not be read
    this.modeNote = null // the last mode that failed to render
    this.aiText = null // the text the current AI image was made from
    this.instructions = [] // what the edited image was asked to be, in order
  }

  // The first draft: reads every candidate and selects the best one, unless an existing image is
  // being kept.
  async useDraft ({ imageUrls = [], title, summary }) {
    this.title = title
    this.summary = summary
    await this.addCandidates(imageUrls)
    if (this.candidates.length && !this.current) await this.choose(0)
  }

  // A corrected draft: the text changes, the image does not. The one exception is a draft that had
  // no image to begin with, where a candidate the correction brings (a URL the requester typed) is
  // what they asked for.
  async revise ({ imageUrls = [], title, summary }) {
    this.title = title
    this.summary = summary
    const hadNone = this.candidates.length === 0 && this.mode === 'none' && !this.touched
    await this.addCandidates(imageUrls)
    if (hadNone && this.candidates.length) await this.choose(0)
    else await this.updateSheet()
  }

  // An image the requester gave in words: an image URL or attachment replaces the image (it becomes
  // a candidate and is selected), anything else is an edit of the image shown now. Resolves to
  // false if the image could not be changed (modeNote says why).
  async instruct ({ text = '', images = [] }) {
    this.touched = true
    const urls = [...images, ...(text.match(/https?:\/\/\S+/g) || [])]
    if (urls.length) {
      const before = this.candidates.length
      // A replacement makes room: the oldest candidates go first.
      if (before + urls.length > MAX_IMAGE_CANDIDATES) this.dropCandidates(before + urls.length - MAX_IMAGE_CANDIDATES)
      const kept = this.candidates.length
      await this.addCandidates(urls)
      if (this.candidates.length === kept) {
        this.modeNote = `指定された画像を使えませんでした${this.readNote ? `（${this.readNote}）` : ''}`
        return false
      }
      await this.choose(kept)
      return true
    }
    return this.edit(text)
  }

  dropCandidates (count) {
    const selected = this.candidates[this.selected]
    this.candidates.splice(0, count)
    const index = this.candidates.indexOf(selected)
    this.selected = index === -1 ? null : index
    for (const key of [...this.rendered.keys()]) if (/^\d+:/.test(key)) this.rendered.delete(key)
    if ((this.mode === 'crop' || this.mode === 'fit') && this.selected === null) this.mode = 'none'
  }

  // Edits the image shown now as told; without one, makes a new image to match.
  async edit (instruction) {
    try {
      const edited = await editCover({ title: this.title, summary: this.summary, instruction, source: this.buffer, size: this.size })
      this.rendered.set('edited', edited)
      this.instructions = this.mode === 'edited' ? [...this.instructions, instruction] : [instruction]
      this.mode = 'edited'
      this.modeNote = null
    } catch (e) {
      this.modeNote = `画像の編集に失敗しました: ${e.hint || e.message}`
      return false
    }
    await this.updateSheet()
    return true
  }

  async addCandidates (imageUrls) {
    const known = new Set(this.candidates.map(c => c.url))
    const urls = imageUrls.filter(url => !known.has(url)).slice(0, MAX_IMAGE_CANDIDATES - this.candidates.length)
    const read = await Promise.all(urls.map(async url => {
      try {
        const source = (await urlFetcher.fetchImage(url)).buffer
        return { url, source, defaultMode: await defaultMode(source, this.size) }
      } catch (e) {
        return { url, error: e.message }
      }
    }))
    this.candidates.push(...read.filter(c => !c.error))
    const failed = read.filter(c => c.error)
    if (failed.length) this.readNote = `使えなかった画像: ${failed.map(c => c.error).join(' / ')}`
  }

  async updateSheet () {
    this.sheet = this.candidates.length > 1
      ? await contactSheet(this.candidates.map(c => c.source), this.usesCandidate() ? this.selected : -1)
      : null
  }

  usesCandidate () {
    return this.selected !== null && (this.mode === 'crop' || this.mode === 'fit')
  }

  // Selects candidate `index`, in the mode that suits it.
  async choose (index) {
    if (!this.candidates[index]) return
    this.selected = index
    await this.select(this.candidates[index].defaultMode)
  }

  // Cropping and showing whole need a candidate; the AI can also start from the text alone.
  modes () {
    return [
      ...(this.current ? ['keep'] : []),
      ...(this.selected !== null ? ['crop', 'fit'] : []),
      'ai',
      ...(this.rendered.has('edited') ? ['edited'] : []),
      'none'
    ]
  }

  key (mode) {
    if (mode === 'ai' || mode === 'keep' || mode === 'edited') return mode
    return `${this.selected}:${mode}`
  }

  // Switches to `mode`, rendering it if needed. A failure keeps the previous mode and says why.
  // `again` makes a new AI image even if one was made already.
  async select (mode, { again = false } = {}) {
    const previous = this.mode
    this.mode = mode
    this.modeNote = null
    if (again) this.rendered.delete(this.key(mode))
    if (mode !== 'none' && mode !== 'keep' && !this.rendered.has(this.key(mode))) {
      try {
        this.rendered.set(this.key(mode), await this.render(mode))
        if (mode === 'ai') this.aiText = `${this.title}\n${this.summary}`
      } catch (e) {
        this.mode = previous
        this.modeNote = `${MODES[mode]}に失敗しました: ${e.hint || e.message}`
      }
    }
    await this.updateSheet()
  }

  // A button pressed by the requester, as opposed to a change that follows a draft.
  async pick (action) {
    this.touched = true
    if (action.startsWith('candidate:')) return this.choose(Number(action.slice('candidate:'.length)))
    const mode = action.slice('image:'.length)
    return this.select(mode, { again: mode === 'ai' && this.mode === 'ai' })
  }

  // Whether pressing the AI button would make a new image (as opposed to showing the one made).
  needsAiRender () {
    return this.mode === 'ai' || !this.rendered.has('ai')
  }

  // The draft became the other kind (event <-> forum post), which has another size. Everything is
  // redone at the new size from the same choices; an AI image is cropped rather than redrawn.
  async resize (size) {
    const made = ['ai', 'edited'].filter(key => this.rendered.has(key)).map(key => [key, this.rendered.get(key)])
    this.size = size
    this.rendered.clear()
    for (const c of this.candidates) c.defaultMode = await defaultMode(c.source, size)
    for (const [key, image] of made) this.rendered.set(key, await cropTo(image, size))
    if (this.mode === 'crop' || this.mode === 'fit') await this.select(this.mode)
  }

  render (mode) {
    const source = this.selected !== null ? this.candidates[this.selected].source : null
    if (mode === 'crop') return cropTo(source, this.size)
    if (mode === 'fit') return fitWithBlur(source, this.size)
    return (source ? forReference(source) : Promise.resolve(null))
      .then(reference => generateCover({ title: this.title, summary: this.summary, source: reference, size: this.size }))
  }

  get buffer () {
    if (this.mode === 'none') return null
    if (this.mode === 'keep') return this.current?.buffer || null
    return this.rendered.get(this.key(this.mode)) || null
  }

  describe () {
    const lines = []
    if (this.mode === 'keep') {
      lines.push(MODES.keep)
    } else if (this.buffer) {
      const which = this.candidates.length > 1 && this.usesCandidate() ? `画像${this.selected + 1}・` : ''
      lines.push(`${which}${MODES[this.mode]}（${this.size.width}×${this.size.height}）`)
    } else {
      lines.push('なし')
    }
    if (this.mode === 'edited') lines.push(`指示: ${this.instructions.join(' → ').slice(0, 300)}`)
    if (this.mode === 'ai' && this.aiText !== `${this.title}\n${this.summary}`) {
      lines.push('内容を修正する前に作った画像です。作り直すときは「画像: AIで作り直す」を押してください')
    }
    if (this.candidates.length > 1) {
      const frame = this.usesCandidate() ? '、黄色の枠が選択中' : ''
      lines.push(`候補 ${this.candidates.length} 枚（下の一覧で ${this.candidates.map((_, i) => `画像${i + 1}=${POSITIONS[i]}`).join('、')}${frame}）`)
    }
    if (this.modeNote) lines.push(this.modeNote)
    if (this.readNote) lines.push(this.readNote)
    return lines.join('\n')
  }
}

module.exports = { CoverImage, MODES }
