const fs = require('fs')
const path = require('path')

const EVENTS_DIR = path.join(__dirname, '..', 'bot', 'events')

module.exports = () => {
  const files = fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.js'))
  const once = []
  const on = []
  files.forEach(filename => {
    const filePath = path.join(EVENTS_DIR, filename)
    if (require.cache[filePath]) {
      delete require.cache[filePath]
    }
    const event = require(filePath)
    event.name = event.name.replace('.js', '')
    if (event.type === 'once') {
      once.push({ name: event.name, handle: event.handle })
    } else {
      on.push({ name: event.name, handle: event.handle, ...(event.requiredPerms?.length ? { requiredPerms: event.requiredPerms } : {}) })
    }
  })
  return [on, once]
}
