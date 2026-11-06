// What the mention assistant keeps to in a server, as each server has its own: the server's rules
// (its rules channel) and what its moderators asked of the assistant (/assistantrules, stored in
// guilds.assistant_rules). Both go with every request; the model follows them in its replies,
// within its own instructions (they can only make it stricter).
//
// The rules channel is the one the server set as such in Discord (guild.rulesChannelID), else a
// text channel named like one (ルール, rules, 規約). Its latest RULES_MESSAGES messages, oldest first,
// with the text of their embeds (rules are often posted by a bot), up to MAX_RULES_CHARS, read again
// at most every CACHE_MS.
const RULES_MESSAGES = 20
const MAX_RULES_CHARS = 3000
const CACHE_MS = 60 * 60 * 1000
const RULES_NAME = /ルール|規約|rule/i

const cache = new Map() // guildID -> { at, channelID, text }

// The server's rules channel, or null.
function rulesChannel (guild) {
  const set = guild.rulesChannelID && guild.channels?.get(guild.rulesChannelID)
  if (set) return set
  return [...(guild.channels?.values() || [])].find(c => [0, 5].includes(c.type) && RULES_NAME.test(c.name || '')) || null
}

function messageText (m) {
  const parts = [m.content, ...(m.embeds || []).flatMap(e => [e.title, e.description, ...(e.fields || []).map(f => `${f.name}\n${f.value}`)])]
  return parts.filter(Boolean).join('\n').trim()
}

// The text of the server's rules channel: { channelID, text } or null when it has none (or it cannot
// be read).
async function readRules (guild, { getMessages = (id, options) => global.bot.getMessages(id, options), now = Date.now() } = {}) {
  const channel = rulesChannel(guild)
  if (!channel) return null
  const known = cache.get(guild.id)
  if (known && known.channelID === channel.id && now - known.at < CACHE_MS) return known.text ? known : null
  let text = ''
  try {
    const messages = await getMessages(channel.id, { limit: RULES_MESSAGES })
    text = messages.slice().sort((a, b) => a.timestamp - b.timestamp).map(messageText).filter(Boolean).join('\n\n')
    if (text.length > MAX_RULES_CHARS) text = `${text.slice(0, MAX_RULES_CHARS)}…`
  } catch (e) {
    global.logger?.warn(`Could not read the rules channel of ${guild.id}: ${e.message}`)
  }
  const result = { at: now, channelID: channel.id, text }
  cache.set(guild.id, result)
  return text ? result : null
}

// For tests.
function reset () {
  cache.clear()
}

module.exports = { readRules, rulesChannel, messageText, reset, MAX_RULES_CHARS }
