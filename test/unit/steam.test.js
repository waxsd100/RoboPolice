const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { installSteamStore } = require('../helpers/fakes')
const steam = require('../../src/bot/utils/steam')
const steamSync = require('../../src/bot/modules/steamSync')
const webStore = require('../../src/db/interfaces/postgres/webKnowledge')
const { searchSteam } = require('../../src/bot/modules/eventTools')

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<profile>
  <steamID64>76561198995446647</steamID64>
  <steamID><![CDATA[Nobaman]]></steamID>
  <customURL><![CDATA[nobaman]]></customURL>
  <memberSince>October 5, 2019</memberSince>
  <summary><![CDATA[I used to be a Dota2 player like you.<br>Then I took an arrow in the brain...]]></summary>
  <mostPlayedGames>
    <mostPlayedGame>
      <gameName><![CDATA[RimWorld]]></gameName>
      <gameLink><![CDATA[https://steamcommunity.com/app/294100]]></gameLink>
      <hoursPlayed>5.5</hoursPlayed>
      <hoursOnRecord>320.4</hoursOnRecord>
    </mostPlayedGame>
  </mostPlayedGames>
</profile>`

const SAMPLE_HTML = `
<div class="friendPlayerLevel"><span class="friendPlayerLevelNum">70</span></div>
<a href="https://steamcommunity.com/id/nobaman/games/?tab=all">
  <span class="count_link_label">ゲーム</span>&nbsp;
  <span class="profile_count_link_total">752</span>
</a>
<a href="https://steamcommunity.com/id/nobaman/stats/255710/achievements/">Cities: Skylines</a>
`

const SAMPLE_REVIEWS_HTML = `
<div class="review_box_content">
  <div class="leftcol"><a href="https://steamcommunity.com/app/570"></a></div>
  <div class="rightcol">
    <div class="vote_header">
      <div class="thumb"><img src="icon_thumbsUp.png"></div>
      <div class="title"><a href="https://steamcommunity.com/id/nobaman/recommended/570/">おすすめ</a></div>
      <div class="hours">総プレイ時間：1,234.5時間</div>
    </div>
    <div class="content ">最高のMOBAゲームです。<br>人生が溶けました。</div>
    <div class="posted">投稿日：2023年5月10日</div>
  </div>
</div>
<div class="review_box_content">
  <div class="leftcol"><a href="https://steamcommunity.com/app/999"></a></div>
  <div class="rightcol">
    <div class="vote_header">
      <div class="thumb"><img src="icon_thumbsDown.png"></div>
      <div class="title"><a href="https://steamcommunity.com/id/nobaman/recommended/999/">おすすめしません</a></div>
      <div class="hours">総プレイ時間：2.0時間</div>
    </div>
    <div class="content ">バグが多すぎました。</div>
    <div class="posted">投稿日：2024年1月2日</div>
  </div>
</div>
`

function createFakeSteamFetch () {
  return async url => {
    url = String(url)
    if (url.includes('/?xml=1')) return { ok: true, status: 200, text: async () => SAMPLE_XML }
    if (url.includes('/recommended/')) return { ok: true, status: 200, text: async () => SAMPLE_REVIEWS_HTML }
    if (url.includes('/badges/')) return { ok: true, status: 200, text: async () => '<a href="/id/nobaman/gamecards/427520/">Factorio</a>' }
    if (url.startsWith('https://steamcommunity.com/id/nobaman/')) return { ok: true, status: 200, text: async () => SAMPLE_HTML }
    if (url.includes('GetUserYearInReview')) {
      const year = Number(new URL(url).searchParams.get('year'))
      if (year !== 2025) return { ok: true, status: 200, json: async () => ({ response: {} }) }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            stats: {
              playtime_stats: {
                total_stats: { total_playtime_seconds: 360000 },
                games: [{ appid: 255710, stats: { total_playtime_seconds: 180000 } }],
                game_summary: [
                  { appid: 255710, total_playtime_percentagex100: 5000, rtime_first_played_lifetime: 1600000000 },
                  { appid: 427520, total_playtime_percentagex100: 2500, rtime_first_played_lifetime: 1650000000 }
                ]
              }
            }
          }
        })
      }
    }
    if (url.includes('GetWishlist')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            items: [{ appid: 1091500, priority: 1, date_added: 1700000000 }]
          }
        })
      }
    }
    if (url.includes('IStoreBrowseService/GetItems')) {
      const input = JSON.parse(new URL(url).searchParams.get('input_json'))
      const lang = input.context?.language
      const names = {
        294100: { ja: 'RimWorld', en: 'RimWorld' },
        255710: { ja: 'Cities: Skylines', en: 'Cities: Skylines' },
        427520: { ja: 'Factorio', en: 'Factorio' },
        570: { ja: 'Dota 2', en: 'Dota 2' },
        999: { ja: 'テストゲーム', en: 'Test Game' },
        1091500: { ja: 'サイバーパンク2077', en: 'Cyberpunk 2077' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            store_items: input.ids
              .filter(i => names[i.appid])
              .map(i => ({ appid: i.appid, name: lang === 'english' ? names[i.appid].en : names[i.appid].ja }))
          }
        })
      }
    }
    throw new Error(`unexpected Steam URL: ${url}`)
  }
}

beforeEach(() => {
  process.env.STEAM_ACCOUNTS = 'nobaman'
  delete process.env.STEAM_API_KEY
})
afterEach(() => {
  process.env.STEAM_ACCOUNTS = ''
  delete process.env.STEAM_API_KEY
  installSteamStore()
})

test('steam.getProfile, getReviews, getReplayGames, getWishlist and resolveApps parse public Steam data without an API key', async () => {
  const fetchImpl = createFakeSteamFetch()
  const profile = await steam.getProfile('nobaman', { fetchImpl })
  assert.equal(profile.steamId, '76561198995446647')
  assert.equal(profile.personaName, 'Nobaman')
  assert.equal(profile.customUrl, 'nobaman')
  assert.equal(profile.level, 70)
  assert.equal(profile.gameCount, 752)
  assert.match(profile.summary, /Dota2 player/)
  assert.equal(profile.recentGames.length, 1)
  assert.deepEqual(profile.recentGames[0], { appId: 294100, name: 'RimWorld', recentHours: 5.5, playtimeHours: 320.4 })
  assert.ok(profile.discoveredAppIds.includes(255710))
  assert.ok(profile.discoveredAppIds.includes(427520))

  const reviews = await steam.getReviews('nobaman', { fetchImpl })
  assert.equal(reviews.length, 2)
  assert.equal(reviews[0].appId, 570)
  assert.equal(reviews[0].recommended, true)
  assert.equal(reviews[0].hoursOnRecord, 1234.5)
  assert.equal(reviews[0].posted, '2023年5月10日')
  assert.match(reviews[0].content, /最高のMOBAゲームです。\n人生が溶けました。/)
  assert.equal(reviews[1].recommended, false)

  const replay = await steam.getReplayGames('76561198995446647', { years: [2024, 2025], fetchImpl })
  const cities = replay.find(g => g.appId === 255710)
  const factorio = replay.find(g => g.appId === 427520)
  assert.equal(cities.playtimeHours, 50)
  assert.equal(factorio.playtimeHours, 25)

  const wishlist = await steam.getWishlist('76561198995446647', { fetchImpl })
  assert.equal(wishlist.length, 1)
  assert.equal(wishlist[0].appId, 1091500)
})

test('steamSync syncs profiles, games, reviews and wishlist, writes reviews to webKnowledge, and search_steam & describeServer expose recommendations', async (t) => {
  const { createGuild, createMember, installBot, installYouTubeStore } = require('../helpers/fakes')
  const { describeServer } = require('../../src/bot/modules/eventTools')
  const stored = installSteamStore()
  const webPages = []
  t.mock.method(webStore, 'savePage', async (url, title, sections) => webPages.push({ url, title, sections }))

  const fetchImpl = createFakeSteamFetch()
  await steamSync.applyProfiles({ fetchImpl })
  assert.equal(stored.profiles.length, 1)
  assert.equal(stored.profiles[0].steam_id, '76561198995446647')

  const { newGames, newReviews } = await steamSync.syncAll({ fetchImpl })
  assert.equal(newGames, 5)
  assert.equal(newReviews, 2)
  assert.equal(webPages.length, 1)
  assert.equal(webPages[0].url, 'https://steamcommunity.com/id/nobaman/recommended/')
  assert.match(webPages[0].sections[0].text, /【Dota 2】おすすめ（総プレイ 1234.5 時間）/)

  const all = await searchSteam('')
  assert.match(all, /アカウント: Nobaman（https:\/\/steamcommunity\.com\/id\/nobaman、SteamID: 76561198995446647、Lv\.70/)
  assert.match(all, /直近2週間にプレイしたゲーム（1 本）:\n- RimWorld（総プレイ 320\.4時間、直近2週間 5\.5時間）/)
  assert.match(all, /Dota 2（総プレイ 1234\.5時間）/)
  assert.match(all, /【Dota 2】おすすめ、1234\.5時間、投稿 2023年5月10日/)

  // Generic recommendation query ("おすすめ ゲーム") strips meta-words and returns top games and reviews.
  const rec = await searchSteam('おすすめ ゲーム')
  assert.match(rec, /プレイ時間が多い順の所持・プレイ済みゲーム:/)
  assert.match(rec, /Dota 2（総プレイ 1234\.5時間）［レビュー: おすすめ］/)

  // Searching by a term in review text ("MOBA") matches the game as well as the review.
  const byReviewWord = await searchSteam('MOBA', 'games')
  assert.match(byReviewWord, /「MOBA」に一致した所持・プレイ済みゲーム: 1 本/)
  assert.match(byReviewWord, /Dota 2/)

  // Searching a genre word not literally in titles ("サバイバル") falls back to top games & recommended reviews.
  const fallback = await searchSteam('サバイバル')
  assert.match(fallback, /プレイ時間が多い順の主なゲーム:/)
  assert.match(fallback, /Steam で「おすすめ」しているレビュー:/)

  const filtered = await searchSteam('Factorio', 'games')
  assert.match(filtered, /「Factorio」に一致した所持・プレイ済みゲーム: 1 本/)
  assert.doesNotMatch(filtered, /Dota 2/)

  const wish = await searchSteam('', 'wishlist')
  assert.match(wish, /サイバーパンク2077 \/ Cyberpunk 2077/)

  // describeServer only includes the concise Steam overview and directs the model to search_steam when needed.
  installYouTubeStore()
  const g = createGuild()
  installBot({ guilds: [g] })
  const serverProfile = await describeServer(g, createMember({ id: '1' }), '1')
  assert.match(serverProfile, /### Steam\nNobaman（https:\/\/steamcommunity\.com\/id\/nobaman、所持・プレイ確認ゲーム 5 本／所持総数 752 本・レビュー 2 件・ウィッシュリスト 1 本を保存）\n持っているゲーム・プレイ時間・レビュー・ウィッシュリスト・おすすめのゲームは search_steam で調べる/)
  assert.doesNotMatch(serverProfile, /RimWorld|Dota 2/)
})
