const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createGuild, createMember, installBot } = require('../helpers/fakes')
const gameMentions = require('../../src/bot/modules/gameMentions')
const gameLinks = require('../../src/bot/modules/gameLinks')

const LIST = [
  { id: '542075586886107149', name: 'Apex Legends', aliases: ['Apex Legends'] },
  { id: '1197827812623650866', name: 'Palworld', aliases: ['Palworld / パルワールド', 'Palworld / 幻獸帕魯'] },
  { id: '1402418491272986635', name: 'Minecraft', aliases: ['Minecraft Launcher'] }
]
const discord = async url => {
  assert.equal(url, 'https://discord.com/api/v10/applications/detectable')
  return { ok: true, json: async () => LIST }
}

describe('findGame', () => {
  beforeEach(() => gameMentions.reset())

  test('finds a game by its name or other names, in any language Discord lists, as a mention', async () => {
    assert.deepEqual(await gameMentions.findGame(['エーペックス', 'APEX LEGENDS'], { fetchImpl: discord }), { id: '542075586886107149', name: 'Apex Legends', mention: '<@$542075586886107149>' })
    assert.equal((await gameMentions.findGame(['パルワールド'], { fetchImpl: discord })).mention, '<@$1197827812623650866>')
    assert.equal(await gameMentions.findGame(['Minecraft Dungeons'], { fetchImpl: discord }), null, 'only a name that matches')
  })

  test('reads Discord\'s list once, and gives nothing if it cannot be read', async (t) => {
    let reads = 0
    const counting = async url => { reads++; return discord(url) }
    await gameMentions.findGame(['Minecraft'], { fetchImpl: counting })
    await gameMentions.findGame(['Palworld'], { fetchImpl: counting })
    assert.equal(reads, 1)
    gameMentions.reset()
    t.mock.method(global.logger, 'warn', () => {})
    assert.equal(await gameMentions.findGame(['Minecraft'], { fetchImpl: async () => ({ ok: false, status: 503 }) }), null)
  })
})

describe('the find_game tool', () => {
  test('gives the mention to write and the game\'s page', async (t) => {
    gameMentions.reset()
    t.mock.method(gameMentions, 'findGame', async () => ({ id: '542075586886107149', name: 'Apex Legends', mention: '<@$542075586886107149>' }))
    t.mock.method(gameLinks, 'linksFor', async () => [{ name: 'エーペックスレジェンズ', url: 'https://store.steampowered.com/app/1172470/' }])
    const guild = createGuild()
    installBot({ guilds: [guild] })
    const { createTools } = require('../../src/bot/modules/eventTools')
    const tools = createTools({ guild, member: createMember(), ask: async () => '' })
    assert.ok(tools.declarations.some(d => d.name === 'find_game'))
    const res = await tools.call('find_game', { name: 'エーペックスレジェンズ', name_en: 'Apex Legends' })
    assert.equal(res.result, 'Discord のゲームメンション: <@$542075586886107149>（Apex Legends。返事にこの書き方のまま書くと、ゲームのプロフィールが表示される）\nページ: https://store.steampowered.com/app/1172470/')
  })
})
