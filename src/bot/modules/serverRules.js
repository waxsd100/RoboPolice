// What the mention assistant keeps to in a server, as each server has its own: the server's rules
// (its rules channels) and what its moderators asked of the assistant (/assistantrules, stored in
// guilds.assistant_rules). Both go with every request; the model follows them in its replies,
// within its own instructions (they can only make it stricter).
//
// The rules channels: the one the server set as such in Discord (guild.rulesChannelID), and those
// the light model picks by their names and topics as what members are to read first (ルール, 必読,
// はじめに, 規約, FAQ, お願い…), at most MAX_CHANNELS in all. The pick is made once and kept until the
// server's channels change (their names, topics or which there are); without Gemini, or when the
// pick fails, channels named like rules are taken instead (and the pick is tried again later).
//
// Each channel's latest RULES_MESSAGES messages, oldest first, with the text of their embeds (rules
// are often posted by a bot), up to MAX_RULES_CHARS in all, read again at most every CACHE_MS.
const crypto = require('crypto')

const RULES_MESSAGES = 20
const MAX_RULES_CHARS = 3000
const MAX_CHANNELS = 3
const MAX_CANDIDATES = 150
const CACHE_MS = 60 * 60 * 1000
const RETRY_PICK_MS = 60 * 60 * 1000
const RULES_NAME = /ルール|規約|必読|はじめに|始めに|rule|readme|start-?here/i
const TEXT_TYPES = [0, 5, 15] // text, announcement, forum

const picks = new Map() // guildID -> { signature, ids, at, failed }
const texts = new Map() // guildID -> { at, key, channels }

const drafter = () => require('./eventDrafter')

// The channels that could hold rules: text, announcement and forum channels.
function candidates (guild) {
  return [...(guild.channels?.values() || [])].filter(c => TEXT_TYPES.includes(c.type)).slice(0, MAX_CANDIDATES)
}

function signatureOf (channels) {
  const text = channels.map(c => `${c.id}:${c.name}:${c.topic || ''}`).sort().join('\n')
  return crypto.createHash('sha256').update(text).digest('hex')
}

// Channels named like rules (when the model cannot pick).
function byName (channels) {
  return channels.filter(c => RULES_NAME.test(c.name || '')).map(c => c.id)
}

// The light model picks the channels members are to read first. Resolves to their IDs.
async function askModel (guild, channels) {
  const list = channels.map(c => `${c.id}: #${c.name}${c.topic ? ` — ${String(c.topic).replace(/\s+/g, ' ').slice(0, 100)}` : ''}`).join('\n')
  const content = await drafter().callGemini(drafter().lightModel(), {
    contents: [{
      role: 'user',
      parts: [{
        text: [
          `Discord サーバー「${guild.name || ''}」のチャンネル一覧です。この中から、サーバーのルール・必読事項・はじめに読むこと・禁止事項・運営からのお願いが書かれていそうなチャンネルを、可能性の高い順に最大${MAX_CHANNELS}つ選んでください。`,
          '雑談・告知・ゲーム・募集など、ルールが書かれていないチャンネルは選ばないでください。当てはまるものがなければ「なし」とだけ答えてください。',
          'チャンネル ID だけを、カンマ区切りで答えてください。',
          '',
          '<channels>',
          list,
          '</channels>'
        ].join('\n')
      }]
    }],
    generationConfig: { temperature: 0 }
  }, { timeoutMs: 30 * 1000, purpose: 'serverRules' })
  const answer = (content?.parts || []).map(p => p.text || '').join('')
  const known = new Set(channels.map(c => c.id))
  return [...new Set(answer.match(/\d{15,21}/g) || [])].filter(id => known.has(id)).slice(0, MAX_CHANNELS)
}

// The server's rules channels, the one set in Discord first. Resolves to channels.
async function rulesChannels (guild, { now = Date.now(), pick = module.exports.pick } = {}) {
  const channels = candidates(guild)
  const signature = signatureOf(channels)
  let known = picks.get(guild.id)
  const stale = !known || known.signature !== signature || (known.failed && now - known.at >= RETRY_PICK_MS)
  if (stale) {
    let ids
    let failed = false
    if (drafter().isConfigured()) {
      try {
        ids = await pick(guild, channels)
      } catch (e) {
        global.logger?.warn(`[RULES]: Could not pick the rules channels of ${guild.id}: ${e.message}`)
        failed = true
      }
    } else {
      failed = true
    }
    if (failed) ids = byName(channels)
    known = { signature, ids, at: now, failed }
    picks.set(guild.id, known)
    if (!failed) global.logger?.info(`[RULES]: ${guild.id} rules channels: ${ids.join(', ') || 'none'}`)
  }
  const set = guild.rulesChannelID && guild.channels?.get(guild.rulesChannelID)
  const ids = [...new Set([...(set ? [set.id] : []), ...known.ids])].slice(0, MAX_CHANNELS)
  return ids.map(id => guild.channels.get(id)).filter(Boolean)
}

function messageText (m) {
  const parts = [m.content, ...(m.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}\n${f.value}`)])]
  return parts.filter(Boolean).join('\n').trim()
}

// The text of the server's rules channels: [{ channelID, text }] (those with text), or null when
// there is none.
async function readRules (guild, { getMessages = (id, options) => global.bot.getMessages(id, options), now = Date.now(), pick } = {}) {
  const channels = await rulesChannels(guild, { now, pick })
  if (!channels.length) return null
  const key = channels.map(c => c.id).join(',')
  const known = texts.get(guild.id)
  if (known && known.key === key && now - known.at < CACHE_MS) return known.channels.length ? known.channels : null
  const read = []
  let left = MAX_RULES_CHARS
  for (const channel of channels) {
    if (left <= 0) break
    try {
      const messages = await getMessages(channel.id, { limit: RULES_MESSAGES })
      let text = messages.slice().sort((a, b) => a.timestamp - b.timestamp).map(messageText).filter(Boolean).join('\n\n')
      if (!text) continue
      if (text.length > left) text = `${text.slice(0, left)}…`
      left -= text.length
      read.push({ channelID: channel.id, text })
    } catch (e) {
      global.logger?.warn(`Could not read the rules channel ${channel.id} of ${guild.id}: ${e.message}`)
    }
  }
  texts.set(guild.id, { at: now, key, channels: read })
  return read.length ? read : null
}

// For tests.
function reset () {
  picks.clear()
  texts.clear()
}

// pick: how the channels are picked (askModel; tests replace it).
module.exports = { pick: askModel, askModel, readRules, rulesChannels, byName, messageText, reset, MAX_RULES_CHARS, MAX_CHANNELS }
