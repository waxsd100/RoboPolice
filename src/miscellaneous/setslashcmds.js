require('dotenv').config()
const Eris = require('eris')
const { ArgumentParser } = require('argparse')
const setCmdSlashCmd = require('../bot/slashcommands/setcmds')

// Arg parsing
const argParser = new ArgumentParser({
  description: 'Utility to help set slash commands globally or guild-wide'
})

argParser.add_argument('--scope', {
  help: 'The scope to set the commands, either global or guild'
})

argParser.add_argument('--guild-id', {
  help: 'The guild id to set the commands in, required if scope is guild',
  required: false
})

argParser.add_argument('--bot-token', {
  help: 'The bot token to use to set the commands',
  required: false
})

// Setup a rest bot for setting commands
async function initRestBot () {
  const restBot = new Eris(`Bot ${process.env.BOT_TOKEN}`, {
    restMode: true
  })
  try {
    restBot.application = await restBot.getRESTUser('@me')
  } catch (e) {
    console.error('Failed to fetch who I am with the provided token, is the token correct?')
    throw new Error(e)
  }
  return restBot
}

// Setup arg variables
const scriptArgs = argParser.parse_args()
const setCmdScopeArg = scriptArgs.scope ?? 'global' // 'scopename to extract'
const setCmdGuildIdArg = scriptArgs.guild_id ?? process.env.INIT_COMMANDS_GUILD_ID
const botToken = process.env.BOT_TOKEN ?? scriptArgs.bot_token

if (botToken == null) {
  throw new Error('Cannot create commands without the env variable BOT_TOKEN being set')
} else if (setCmdGuildIdArg == null && setCmdScopeArg !== 'global') {
  throw new Error('Cannot create commands in a server without the env variable INIT_COMMANDS_GUILD_ID being set or the guild id being passed as an argument')
}

console.log(`Setting commands using ${setCmdScopeArg === 'global' ? 'global' : 'guild'} scope${setCmdGuildIdArg && setCmdScopeArg === 'guild' ? ` in guild ${setCmdGuildIdArg}` : ''}`)

global.logger = console // patch terrible global variable usage
global.bot = {
  bulkEditCommands: async commands => {
    const restBot = await initRestBot()
    await restBot.bulkEditCommands(commands)
  },
  bulkEditGuildCommands: async (guildId, commands) => {
    const restBot = await initRestBot()
    await restBot.bulkEditGuildCommands(guildId, commands)
  }
}

// this payload will be read by the setcmds.js handler
const mockedInteraction = {
  data: {
    options: [
      {
        name: 'scope',
        value: setCmdScopeArg
      }
    ]
  },
  channel: {
    guild: {
      id: process.env.INIT_COMMANDS_GUILD_ID
    }
  },
  createMessage: () => {}
}

setCmdSlashCmd.func(mockedInteraction).then(() => {
  process.exit(0)
})
  .catch(e => {
    console.error('Failed to run set commands handler', e)
    process.exit(1)
  })
