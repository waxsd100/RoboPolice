// Ensures Discord's global slash commands match slashcommandconstants.js on startup, without
// writing to Discord on restarts where nothing changed. Especially helpful on initial bot setup
// (before %setcmd global has ever been run) and when updates add new slash commands or options.
// Set AUTO_SYNC_COMMANDS=false to disable automatic startup sync.
const { commands } = require('./slashcommandconstants')

function normalizeChoice (c) {
  return {
    name: c.name,
    value: c.value,
    name_localizations: c.name_localizations || null
  }
}

function normalizeOption (o) {
  return {
    type: o.type,
    name: o.name,
    description: o.description,
    description_localizations: o.description_localizations || null,
    required: Boolean(o.required),
    min_value: o.min_value ?? null,
    max_value: o.max_value ?? null,
    max_length: o.max_length ?? null,
    channel_types: o.channel_types ? [...o.channel_types].sort((a, b) => a - b) : null,
    choices: o.choices ? o.choices.map(normalizeChoice) : null,
    options: o.options ? o.options.map(normalizeOption) : null
  }
}

function normalizeCommand (cmd) {
  return {
    name: cmd.name,
    type: cmd.type || 1,
    description: cmd.description,
    description_localizations: cmd.description_localizations || null,
    options: cmd.options ? cmd.options.map(normalizeOption) : null
  }
}

function commandsMatch (existing, desired) {
  if (!Array.isArray(existing) || existing.length !== desired.length) return false
  const byName = new Map(existing.map(c => [c.name, normalizeCommand(c)]))
  for (const cmd of desired) {
    const current = byName.get(cmd.name)
    if (!current) return false
    if (JSON.stringify(current) !== JSON.stringify(normalizeCommand(cmd))) return false
  }
  return true
}

async function syncGlobalSlashCommands (bot = global.bot) {
  if (process.env.AUTO_SYNC_COMMANDS === 'false') return false
  if (!bot || typeof bot.getCommands !== 'function' || typeof bot.bulkEditCommands !== 'function') return false
  try {
    const existing = await bot.getCommands()
    if (commandsMatch(existing, commands)) return false
    await bot.bulkEditCommands(commands)
    global.logger?.info?.(`[SLASH COMMANDS]: Automatically synced ${commands.length} global slash commands`)
    return true
  } catch (e) {
    global.logger?.warn?.(`[SLASH COMMANDS]: Could not auto-sync global slash commands: ${e.message}`)
    return false
  }
}

module.exports = { syncGlobalSlashCommands, commandsMatch, normalizeCommand }
