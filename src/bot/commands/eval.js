const util = require('util')
const { redact } = require('../utils/redact')

function formatEval (val) {
  let str = redact(typeof val === 'string' ? val : util.inspect(val, { depth: 1 }))
  if (str.length > 1900) str = `${str.slice(0, 1897)}...`
  return '```xl\n' + str + '\n```'
}

module.exports = {
  func: async (message, suffix) => {
    try { // This eval command is from https://github.com/TheSharks/WildBeast/ because I really like their method
      const returned = eval(suffix)
      message.channel.createMessage(formatEval(returned)).then(ms => {
        if (returned !== undefined && returned !== null && typeof returned.then === 'function') {
          returned.then(() => {
            ms.edit(formatEval(returned))
          }, e => {
            ms.edit(formatEval(e))
          })
        }
      }).catch(() => { })
    } catch (e) {
      message.channel.createMessage(formatEval(e)).catch(() => { })
    }
  },
  name: 'eval',
  description: 'Bot owner debug command.',
  type: 'creator',
  hidden: true
}
