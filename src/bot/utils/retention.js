const DISCORD_EPOCH = 1420070400000

function messageTimestamp (messageID) {
  return Math.floor(Number(messageID) / 4194304) + DISCORD_EPOCH
}

// A missing row has two very different causes: prune.js removed it because the message aged out, or
// the message was never stored at all (a bot message while /logbots is off, an automod action, or
// anything sent before the bot could see it). Only the first deserves a "we had this and let it go"
// log entry - emitting one for the second would turn every old untracked deletion into noise.
function isBeyondRetention (messageID) {
  const days = parseInt(process.env.MESSAGE_HISTORY_DAYS, 10)
  if (!Number.isInteger(days) || days <= 0) return false // nothing is being pruned
  return Date.now() - messageTimestamp(messageID) > days * 86400000
}

module.exports = { isBeyondRetention, messageTimestamp }
