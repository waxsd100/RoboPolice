const { test, describe, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { configureGateway, installGemini } = require('../helpers/fakes')
const urlFetcher = require('../../src/bot/utils/urlFetcher')
const gameLinks = require('../../src/bot/modules/gameLinks')

const steam = items => async url => {
  assert.match(url, /^https:\/\/store\.steampowered\.com\/api\/storesearch\/\?term=.+&l=japanese&cc=JP$/)
  return { ok: true, json: async () => ({ items }) }
}

afterEach(() => { delete process.env.GAME_LINKS })

describe('steamPage', () => {
  test('the page of the game whose name matches, not the nearest hit', async () => {
    const items = [{ type: 'app', name: 'Minecraft Dungeons', id: 1672970 }, { type: 'app', name: 'エーペックスレジェンズ', id: 1172470 }]
    assert.deepEqual(await gameLinks.steamPage('エーペックス レジェンズ', { fetchImpl: steam(items) }), { name: 'エーペックスレジェンズ', url: 'https://store.steampowered.com/app/1172470/' })
    assert.equal(await gameLinks.steamPage('Minecraft', { fetchImpl: steam(items) }), null)
  })

  test('names compare without case, width or punctuation', () => {
    assert.equal(gameLinks.normalize('ＡＰＥＸ　Legends™'), gameLinks.normalize('apex legends'))
  })
})

describe('linksFor', () => {
  test('Steam first (Japanese name, then English), else an official page that opens', async (t) => {
    configureGateway()
    const searched = []
    t.mock.method(gameLinks, 'steamPage', async name => { searched.push(name); return name === 'Apex Legends' ? { name, url: 'https://store.steampowered.com/app/1172470/' } : null })
    const read = t.mock.method(urlFetcher, 'fetchPageText', async url => ({ url, text: 'ok' }))
    installGemini([[{ text: 'https://www.pokemon.co.jp/ex/legends_za/' }]])
    const links = await gameLinks.linksFor([{ name: 'エーペックスレジェンズ', nameEn: 'Apex Legends' }, { name: 'ポケモンレジェンズ Z-A', nameEn: null }])
    assert.deepEqual(links, [
      { name: 'エーペックスレジェンズ', url: 'https://store.steampowered.com/app/1172470/' },
      { name: 'ポケモンレジェンズ Z-A', url: 'https://www.pokemon.co.jp/ex/legends_za/' }
    ])
    assert.deepEqual(searched, ['エーペックスレジェンズ', 'Apex Legends', 'ポケモンレジェンズ Z-A'])
    assert.equal(read.mock.calls[0].arguments[0], 'https://www.pokemon.co.jp/ex/legends_za/')
  })

  test('a page that does not open, or none found, is left out; GAME_LINKS=false turns it off', async (t) => {
    configureGateway()
    t.mock.method(gameLinks, 'steamPage', async () => null)
    t.mock.method(urlFetcher, 'fetchPageText', async () => { throw new Error('HTTP 404') })
    installGemini([[{ text: 'https://example.com/made-up' }], [{ text: 'なし' }]])
    assert.deepEqual(await gameLinks.linksFor([{ name: 'A' }, { name: 'B' }]), [])
    process.env.GAME_LINKS = 'false'
    assert.deepEqual(await gameLinks.linksFor([{ name: 'A' }]), [])
  })
})
