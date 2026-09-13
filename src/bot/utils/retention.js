const DISCORD_EPOCH = 1420070400000

function messageTimestamp (messageID) {
  return Math.floor(Number(messageID) / 4194304) + DISCORD_EPOCH
}

// Unset (or non-positive/non-numeric) means retention is unlimited by design, not a
// misconfiguration: a deployment can deliberately keep messages forever. null is that state.
function getRetentionDays () {
  const days = parseInt(process.env.MESSAGE_HISTORY_DAYS, 10)
  if (!Number.isInteger(days) || days <= 0) return null
  return days
}

// A missing row has two very different causes: prune.js removed it because the message aged out, or
// the message was never stored at all (a bot message while /logbots is off, an automod action, or
// anything sent before the bot could see it). Only the first deserves a "we had this and let it go"
// log entry - emitting one for the second would turn every old untracked deletion into noise.
function isBeyondRetention (messageID) {
  const days = getRetentionDays()
  if (!days) return false // nothing is being pruned
  return Date.now() - messageTimestamp(messageID) > days * 86400000
}

// Centralized Japanese wording for the two places users are told what happens to their messages
// (/clearmydata, /help). Keeping it here means an unset MESSAGE_HISTORY_DAYS can never render as
// the literal string "undefined 日で自動的に削除されます", and both commands stay in sync.
function retentionDeletionClause () {
  const days = getRetentionDays()
  return days ? `${days} 日で自動的に削除されます` : '期限を設けず保存されます（自動削除は行われません）'
}

function retentionWindowClause (botName) {
  const days = getRetentionDays()
  return days
    ? `メッセージの保存期間は ${days} 日で、それより古いメッセージを削除・編集した場合は「内容は保持期間外」として記録されます。`
    : `${botName} はメッセージの保存期間に上限を設けていないため、古いメッセージであっても削除・編集時に内容を表示できます。`
}

module.exports = { isBeyondRetention, messageTimestamp, getRetentionDays, retentionDeletionClause, retentionWindowClause }
