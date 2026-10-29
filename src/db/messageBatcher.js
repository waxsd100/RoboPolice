global.logger = require('../miscellaneous/logger');
const format = require('pg-format')
const pool = require('./clients/postgres')
const aes = require('./aes')
const { ensureChannelColumns } = require('./messageColumns')
const batch = []
global.timesSubmitted = 0
global.totalMessagesSubmitted = 0

// Messages held in memory before one batched INSERT. Anything still here is lost on an unclean
// restart, so keep it small: this bot logs one server, not thousands.
const BATCH_SIZE = 10

async function addItem (messageAsArray) {
  batch.push(messageAsArray)
  if (batch.length >= BATCH_SIZE) {
    await submitBatch(BATCH_SIZE)
  }
}

// Whether messages can be stored with their channel. If adding the columns failed (no ALTER
// privilege, a lock timeout), messages are still stored as before rather than lost.
async function channelColumnsReady () {
  try {
    await ensureChannelColumns()
    return true
  } catch (e) {
    global.logger.warn(`Storing messages without their channel: ${e.message}`)
    return false
  }
}

// A batch row: [id, author_id, encrypted content, encrypted attachments, ts, channel_id, guild_id]
async function submitBatch (batchSize) {
  const withChannel = await channelColumnsReady()
  const toSubmit = batch.splice(0, batchSize)
  const poolClient = await pool.getPostgresClient()
  await poolClient.query(withChannel
    ? format('INSERT INTO messages (id, author_id, content, attachment_b64, ts, channel_id, guild_id) VALUES %L ON CONFLICT DO NOTHING', toSubmit)
    : format('INSERT INTO messages (id, author_id, content, attachment_b64, ts) VALUES %L ON CONFLICT DO NOTHING', toSubmit.map(row => row.slice(0, 5))))
  poolClient.release()
  global.timesSubmitted += 1
  global.totalMessagesSubmitted += batchSize

  const msg = `Submitted ${toSubmit.length} messages within batch #${global.timesSubmitted} (${global.totalMessagesSubmitted} total).`;
  global.logger.info(msg)
  global.webhook.generic(msg)

  return toSubmit.length
}

function getMessage (messageID) {
  const message = batch.find(m => m[0] === messageID)
  if (!message) return
  return {
    id: message[0],
    author_id: message[1],
    content: aes.decrypt(message[2]),
    // Note that we can use '|' as a separator since base64url encoded strings (the output of aes.decrypt) cannot contain the '|' character.
    attachment_b64: message[3] ? message[3].split("|").map(encrypted_img_url => aes.decrypt(encrypted_img_url)).join("|") : '',
    ts: Date.parse(message[4])
  }
}

function updateMessage (messageID, changedAttrs) {
  for (let i = 0; i < batch.length; i++) {
    if (batch[i][0] === messageID) {
      // Both keys can be present at once (an edit that changes text and removes an image), so this
      // must not be if/else if: that silently dropped the image-removal whenever content also
      // changed on a message still sitting in the in-memory batch (not yet flushed to Postgres).
      let handled = false
      if ('content' in changedAttrs) {
        batch[i][2] = aes.encrypt(changedAttrs.content || 'None')
        handled = true
      }
      if ('imageUrls' in changedAttrs) {
        batch[i][3] = changedAttrs.imageUrls.map(url => aes.encrypt(Buffer.from(url).toString("base64url"))).join("|")
        handled = true
      }
      if (!handled) {
        const msg = `updateMessage called with unsupported changedAttrs: ${JSON.stringify(changedAttrs)}`
        global.logger.warn(msg)
        global.webhook.warn(msg);
      }
      break
    }
  }
}

// Messages of `channelID` still waiting in memory, newest first, decrypted like rows from Postgres.
function getChannelMessages (channelID) {
  return batch
    .filter(m => m[5] === channelID)
    .map(m => ({ id: m[0], author_id: m[1], content: aes.decrypt(m[2]), ts: new Date(m[4]), channel_id: m[5] }))
    .reverse()
}

// Drops a message that is still waiting in memory, so a deletion reaches it before it is stored.
function removeMessage (messageID) {
  const index = batch.findIndex(m => m[0] === messageID)
  if (index !== -1) batch.splice(index, 1)
}

exports.getMessage = getMessage
exports.removeMessage = removeMessage
exports.getChannelMessages = getChannelMessages
exports.addItem = addItem
exports.updateMessage = updateMessage
exports.submitBatch = submitBatch
