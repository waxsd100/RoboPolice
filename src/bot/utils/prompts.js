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

// A prompt split at its "## " headings: the text before the first one (`head`) and each section's
// text by its heading. For prompts that fill a structure rather than being sent whole.
function sections (name, view = {}) {
  const [head, ...parts] = render(name, view).split(/^## /m)
  const bodies = new Map()
  for (const part of parts) {
    const end = part.indexOf('\n')
    const heading = (end === -1 ? part : part.slice(0, end)).trim()
    if (bodies.has(heading)) throw new Error(`Prompt ${name} has two "## ${heading}" sections`)
    bodies.set(heading, end === -1 ? '' : part.slice(end + 1).trim())
  }
  return { head: head.trim(), bodies }
}

function unknownHeadings (name, bodies, known) {
  const unknown = [...bodies.keys()].filter(key => !known.includes(key))
  if (unknown.length) throw new Error(`Prompt ${name} has section(s) for nothing: ${unknown.join(', ')}`)
}

// A tool the model can call, with its descriptions from prompts/tools/<name>.md: the text before the
// first "## " heading describes the tool, and each "## <parameter>" section describes that
// parameter. `parameters` is the schema without those descriptions; a parameter with no section is
// left without one, and a section naming no parameter is an error (a misspelt or stale heading).
// A property that already has a description (one shared by several tools) keeps it.
function tool (name, { parameters, view = {} } = {}) {
  const file = `tools/${name}`
  const { head, bodies } = sections(file, view)
  const properties = parameters?.properties || {}
  unknownHeadings(file, bodies, Object.keys(properties))
  const declaration = { name, description: head }
  if (parameters) {
    declaration.parameters = {
      ...parameters,
      properties: Object.fromEntries(Object.entries(properties).map(([key, schema]) =>
        [key, bodies.has(key) && !schema.description ? { ...schema, description: bodies.get(key) } : { ...schema }]))
    }
  }
  return declaration
}

// The questions for sokudan (prompts/sokudan/<name>.md), one "## <question>" section each: its text
// is the instructions; a `choice` question lists its options as "- key: description" lines, a
// `score` question its levels as "1. description" lines (lowest first). `spec` gives each question's
// type, and for a choice its keys in the order they are offered (the order matters to sokudan, so
// the file must list them in that order).
function questions (name, spec) {
  const file = `sokudan/${name}`
  const { bodies } = sections(file)
  unknownHeadings(file, bodies, Object.keys(spec))
  return Object.fromEntries(Object.entries(spec).map(([key, { type, choices, levels }]) => {
    if (!bodies.has(key)) throw new Error(`Prompt ${file} has no "## ${key}" section`)
    const lines = bodies.get(key).split('\n')
    const listed = lines.filter(l => /^(- |\d+\. )/.test(l))
    const instructions = lines.filter(l => !listed.includes(l)).join('\n').trim()
    const question = { type, instructions }
    if (type === 'choice') {
      const options = listed.map(l => l.match(/^- ([^:]+):\s*(.+)$/)).filter(Boolean).map(m => [m[1].trim(), m[2].trim()])
      if (options.map(o => o[0]).join(',') !== choices.join(',')) throw new Error(`Prompt ${file} must list "${key}" choices as ${choices.join(', ')}`)
      question.criteria = Object.fromEntries(options)
    } else if (type === 'score') {
      const steps = listed.map(l => l.match(/^\d+\. (.+)$/)).filter(Boolean).map(m => m[1].trim())
      if (steps.length !== levels) throw new Error(`Prompt ${file} must list ${levels} levels for "${key}"`)
      question.criteria = steps
    }
    return [key, question]
  }))
}

module.exports = { render, lines, sections, tool, questions, PROMPTS_DIR }
