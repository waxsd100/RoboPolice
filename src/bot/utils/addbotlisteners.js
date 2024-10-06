const listenerIndexer = require('../../miscellaneous/listenerIndexer')
const eventMiddleware = require('../modules/eventmiddleware')

module.exports = () => {
  const [on, once] = listenerIndexer()

  on.forEach(async event => eventMiddleware(event, 'on'))
  once.forEach(async event => eventMiddleware(event, 'once'))
}
