// Errors Eris reports. Some carry a whole API response: when it cannot read one message of a
// page, Eris adds the JSON of all of them (up to 100 messages with their authors), which floods
// the log (Railway drops lines past 500 a second). Only the error itself is logged, cut short.
const MAX_LOGGED = 2000

function loggable (e) {
  let text = e instanceof Error ? (e.stack || e.message) : String(e)
  // "Error creating message from channel messages\n<stack>\n<JSON of the page>"
  const json = text.search(/\n\[?\{"/)
  if (json !== -1) text = `${text.slice(0, json)}\n(response left out, ${text.length - json} characters)`
  return text.length > MAX_LOGGED ? `${text.slice(0, MAX_LOGGED)}… (${text.length} characters)` : text
}

module.exports = {
  name: 'error',
  type: 'on',
  handle: e => {
    console.error('[ERIS] ERROR: ', loggable(e))
  },
  loggable
}
