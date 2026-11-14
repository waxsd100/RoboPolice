const fs = require('fs')
const path = require('path')
const GenericCommand = require('../bot/bases/GenericCommand')

const COMMANDS_DIR = path.join(__dirname, '..', 'bot', 'commands')

module.exports = () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'))
  files.forEach(filename => {
    const filePath = path.join(COMMANDS_DIR, filename)
    if (require.cache[filePath]) {
      delete require.cache[filePath]
    }
    // truly gross code that should be remade eventually
    // eslint-disable-next-line no-new
    new GenericCommand(require(filePath))
  })
}
