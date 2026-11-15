// The prompts sent to the AI, kept as Markdown files under src/bot/prompts (`chat/system` is
// src/bot/prompts/chat/system.md) and filled in with Mustache:
//   {{name}}               replaced with the value (as is: nothing is HTML-escaped)
//   {{#name}}…{{/name}}    kept only when the value is set (non-empty string, true, non-empty list)
//   {{^name}}…{{/name}}    kept only when it is not
//   {{! note }}            a note for whoever edits the file, left out of the prompt
// A line holding only a section tag or a note is left out whole, with its line break.
//
// Every name a file uses has to be given (null or '' is fine), so a misspelt name fails at once
// instead of leaving a gap in the prompt. One line break at the end of a file is not part of it.
// Files are read once and kept.
const fs = require('fs')
const path = require('path')
const Mustache = require('mustache')

const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts')
const templates = new Map()

function template (name) {
  if (!templates.has(name)) {
    const file = path.join(PROMPTS_DIR, `${name}.md`)
    if (path.relative(PROMPTS_DIR, file).startsWith('..')) throw new Error(`Prompt ${name} is outside ${PROMPTS_DIR}`)
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
    templates.set(name, { text, names: namesIn(Mustache.parse(text)) })
  }
  return templates.get(name)
}

// The names a parsed template looks up (sections included). Notes and text are not names.
function namesIn (tokens, names = new Set()) {
  for (const [type, value, , , children] of tokens) {
    if (['name', '&', '#', '^'].includes(type) && value !== '.') names.add(value.split('.')[0])
    if (Array.isArray(children)) namesIn(children, names)
  }
  return names
}

const noEscape = value => String(value)

function render (name, view = {}) {
  const { text, names } = template(name)
  const missing = [...names].filter(n => !Object.prototype.hasOwnProperty.call(view, n))
  if (missing.length) throw new Error(`Prompt ${name} needs ${missing.map(n => `{{${n}}}`).join(', ')}`)
  return Mustache.render(text, view, {}, { escape: noEscape })
}

// A prompt's lines, for prompts used as lists of rules (the reply lengths).
const lines = (name, view) => render(name, view).split('\n')

module.exports = { render, lines, PROMPTS_DIR }
