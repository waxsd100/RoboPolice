// The language slash commands answer in: Japanese for a Japanese Discord client, English for any
// other (and Japanese when Discord does not say). Discord sends the client's language with every
// interaction (`locale`, and the server's as `guild_locale`); Eris does not keep them, so they are
// copied onto the interaction as it is made (below).
const Eris = require('eris')

const from = Eris.Interaction.from
if (!from.keepsLocale) {
  Eris.Interaction.from = function (data, client) {
    const interaction = from.call(this, data, client)
    interaction.locale = data.locale
    interaction.guildLocale = data.guild_locale
    return interaction
  }
  Eris.Interaction.from.keepsLocale = true
}

const LANGUAGES = ['ja', 'en']

// 'ja' or 'en'.
function langOf (interaction) {
  const locale = interaction?.locale || interaction?.guildLocale
  if (!locale) return 'ja'
  return String(locale).toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

// The text for the interaction's language, of { ja, en } (Japanese when there is no English).
function pick (interaction, texts) {
  return texts[langOf(interaction)] ?? texts.ja
}

module.exports = { langOf, pick, LANGUAGES }
