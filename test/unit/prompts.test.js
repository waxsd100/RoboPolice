const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Mustache = require('mustache')
const prompts = require('../../src/bot/utils/prompts')

const promptFiles = (dir = prompts.PROMPTS_DIR) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name)
  if (entry.isDirectory()) return promptFiles(file)
  return entry.name.endsWith('.md') && entry.name !== 'README.md' ? [path.relative(prompts.PROMPTS_DIR, file).replace(/\.md$/, '').split(path.sep).join('/')] : []
})

test('every prompt file renders, with each of its names given', () => {
  const names = promptFiles()
  assert.ok(names.includes('chat/system'))
  for (const name of names) {
    const text = fs.readFileSync(path.join(prompts.PROMPTS_DIR, `${name}.md`), 'utf8')
    const view = {}
    const collect = tokens => tokens.forEach(([type, value, , , children]) => {
      if (['name', '&', '#', '^'].includes(type)) view[value] = 'x'
      if (children) collect(children)
    })
    collect(Mustache.parse(text))
    const out = prompts.render(name, view)
    assert.ok(out.trim(), `${name} is empty`)
    assert.doesNotMatch(out, /\{\{|\}\}/, `${name} has a tag left over`)
    assert.doesNotMatch(out, /\n$/, `${name} ends with a line break`)
  }
})

test('fills in values as they are, and keeps sections only when set', () => {
  const system = prompts.render('chat/system', { modelName: 'A & <B>', persona: '', uncensored: false })
  assert.match(system, /「A & <B>」と答える/)
  assert.doesNotMatch(system, /運営者が設定したキャラクター/)
  assert.doesNotMatch(system, /^\{\{!|会話の返事（メンション）のシステム指示/m)
  const withPersona = prompts.render('chat/system', { modelName: 'A & <B>', persona: 'ござる口調', uncensored: false })
  assert.ok(withPersona.endsWith('\n\n## 運営者が設定したキャラクター\nござる口調'))
  assert.ok(withPersona.startsWith(`${system}\n\n`))

  const r18 = prompts.render('chat/uncensored/rules', { r18Mode: true, compact: false })
  const plain = prompts.render('chat/uncensored/rules', { r18Mode: false, compact: false })
  assert.match(r18, /依頼者は成人向け・R18 モードを指定しています/)
  assert.doesNotMatch(plain, /依頼者は成人向け・R18 モードを指定しています/)
  assert.equal(r18.split('\n').length, plain.split('\n').length + 1)
})

test('refuses a prompt with a name left out', () => {
  assert.throws(() => prompts.render('chat/system', { modelName: 'A', uncensored: false }), /chat\/system needs \{\{persona\}\}/)
  assert.throws(() => prompts.render('../../index'), /outside/)
})

test('keeps the reply length rules as lines', () => {
  const lines = prompts.lines('chat/reply-length/short')
  assert.equal(lines.length, 2)
  assert.ok(lines.every(l => l.startsWith('- ')))
})
