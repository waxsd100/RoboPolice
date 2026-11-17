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

  const r18 = prompts.render('chat/uncensored/rules', { r18Mode: true, compact: false, story: false })
  const plain = prompts.render('chat/uncensored/rules', { r18Mode: false, compact: false, story: false })
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

test('a tool takes its description and each parameter description from its file', () => {
  const declaration = prompts.tool('submit_forum_post_draft', {
    view: { maxTitle: 100, maxContent: 2000, maxTags: 5, maxImages: 4 },
    parameters: { type: 'OBJECT', properties: { title: { type: 'STRING' }, found: { type: 'BOOLEAN' }, channel_id: { type: 'STRING' }, content: { type: 'STRING' }, tags: { type: 'ARRAY' }, image_urls: { type: 'ARRAY' }, reason: { type: 'STRING' }, image_instruction: { type: 'STRING', description: 'shared' } }, required: ['found'] }
  })
  assert.equal(declaration.name, 'submit_forum_post_draft')
  assert.match(declaration.description, /^フォーラムへの投稿を頼まれたとき/)
  assert.doesNotMatch(declaration.description, /##/)
  assert.equal(declaration.parameters.properties.title.description, '投稿の題名（100文字以内）')
  assert.equal(declaration.parameters.properties.image_instruction.description, 'shared', 'a description already given is kept')
  assert.deepEqual(declaration.parameters.required, ['found'])
  // Without parameters there is no `parameters` at all: Gemini rejects an empty OBJECT schema.
  assert.deepEqual(Object.keys(prompts.tool('list_channels')), ['name', 'description'])
})

test('a tool file describing a parameter the tool does not have is refused', () => {
  assert.throws(() => prompts.tool('submit_chat_reply', { parameters: { type: 'OBJECT', properties: { body: { type: 'STRING' } } } }), /section\(s\) for nothing: text/)
})

test('sokudan questions: instructions, choices in the given order, and score levels', () => {
  const q = prompts.questions('mention', {
    intent: { type: 'choice', choices: ['event', 'chat', 'forum'] },
    needs_deep: { type: 'noul' },
    is_r18: { type: 'noul' },
    is_story: { type: 'noul' },
    complexity: { type: 'score', levels: 3 }
  })
  assert.equal(q.intent.instructions, 'この依頼メッセージがBOTに何を求めているか選んでください。')
  assert.deepEqual(Object.keys(q.intent.criteria), ['event', 'chat', 'forum'])
  assert.equal(q.needs_deep.criteria, undefined)
  assert.equal(q.complexity.criteria.length, 3)
  assert.throws(() => prompts.questions('mention', { intent: { type: 'choice', choices: ['chat', 'event', 'forum'] }, needs_deep: { type: 'noul' }, is_r18: { type: 'noul' }, is_story: { type: 'noul' }, complexity: { type: 'score', levels: 3 } }), /must list "intent" choices as chat, event, forum/)
  assert.throws(() => prompts.questions('refusal', { refusal: { type: 'noul' }, other: { type: 'noul' } }), /no "## other" section/)
})
