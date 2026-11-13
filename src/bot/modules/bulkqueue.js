const guildWebhookCacher = require('./guildWebhookCacher')

const MAX_EMBEDS_PER_FLUSH = 10
const MAX_CHARS_PER_FLUSH = 6000

const webhookIDToQueue = new Map()
const webhookIDToTimeout = new Map()
const webhookIDToCharLimit = new Map()

function scheduleFlush (senderPkg, guildSettings) {
  const webhookID = senderPkg.webhookID
  clearTimeout(webhookIDToTimeout.get(webhookID))
  const timer = setTimeout(() => {
    flushQueue(webhookID, senderPkg, guildSettings)
  }, 5000)
  timer.unref?.()
  webhookIDToTimeout.set(webhookID, timer)
}

function flushQueue (webhookID, fallbackPkg, guildSettings) {
  const queued = webhookIDToQueue.get(webhookID)
  clearTimeout(webhookIDToTimeout.get(webhookID))
  webhookIDToQueue.delete(webhookID)
  webhookIDToTimeout.delete(webhookID)
  webhookIDToCharLimit.delete(webhookID)
  if (!queued || queued.length === 0) return

  const headPkg = queued[0] || fallbackPkg
  const allEmbeds = queued.map(p => p.embeds || []).flat(1)
  const batches = chunkEmbeds(allEmbeds)
  for (const batch of batches) {
    sendBulkLog({ ...headPkg, file: '' }, batch, guildSettings)
  }
}

function chunkEmbeds (embeds) {
  const batches = []
  let current = []
  let currentChars = 0
  for (const embed of embeds) {
    if (!embed) continue
    const len = getSingleEmbedCharLen(embed)
    if (current.length > 0 && (current.length >= MAX_EMBEDS_PER_FLUSH || currentChars + len > MAX_CHARS_PER_FLUSH)) {
      batches.push(current)
      current = []
      currentChars = 0
    }
    current.push(embed)
    currentChars += len
  }
  if (current.length > 0) batches.push(current)
  return batches
}

module.exports = async (senderPkg, guildSettings) => {
  if (!senderPkg) return
  if (senderPkg.file) {
    const batches = chunkEmbeds(senderPkg.embeds || [])
    if (batches.length === 0) {
      sendBulkLog(senderPkg, [], guildSettings)
      return
    }
    batches.forEach((batch, idx) => {
      sendBulkLog(idx === 0 ? senderPkg : { ...senderPkg, file: '' }, batch, guildSettings)
    })
    return
  }

  const incomingEmbeds = senderPkg.embeds || []
  const charsToPush = getEmbedCharLens(incomingEmbeds)
  const webhookID = senderPkg.webhookID

  if (webhookIDToQueue.has(webhookID)) {
    const updatedQueue = webhookIDToQueue.get(webhookID)
    const queuedEmbedCount = updatedQueue.reduce((sum, p) => sum + (p.embeds ? p.embeds.length : 0), 0)
    const currentChars = webhookIDToCharLimit.get(webhookID) || 0

    if (queuedEmbedCount + incomingEmbeds.length <= MAX_EMBEDS_PER_FLUSH && currentChars + charsToPush <= MAX_CHARS_PER_FLUSH) {
      updatedQueue.push(senderPkg)
      webhookIDToCharLimit.set(webhookID, currentChars + charsToPush)
      webhookIDToQueue.set(webhookID, updatedQueue)
      scheduleFlush(senderPkg, guildSettings)
    } else {
      // queue would exceed Discord's 10-embed or 6000-char limit, flush current queue now.
      flushQueue(webhookID, senderPkg, guildSettings)
      if (incomingEmbeds.length > MAX_EMBEDS_PER_FLUSH || charsToPush > MAX_CHARS_PER_FLUSH) {
        for (const batch of chunkEmbeds(incomingEmbeds)) {
          sendBulkLog(senderPkg, batch, guildSettings)
        }
      } else {
        webhookIDToQueue.set(webhookID, [senderPkg])
        webhookIDToCharLimit.set(webhookID, charsToPush)
        scheduleFlush(senderPkg, guildSettings)
      }
    }
  } else {
    if (incomingEmbeds.length > MAX_EMBEDS_PER_FLUSH || charsToPush > MAX_CHARS_PER_FLUSH) {
      for (const batch of chunkEmbeds(incomingEmbeds)) {
        sendBulkLog(senderPkg, batch, guildSettings)
      }
    } else {
      webhookIDToQueue.set(webhookID, [senderPkg])
      webhookIDToCharLimit.set(webhookID, charsToPush)
      scheduleFlush(senderPkg, guildSettings)
    }
  }
}

function getSingleEmbedCharLen (embed) {
  if (!embed) return 0
  let total = 0
  if (typeof embed.title === 'string') total += embed.title.length
  if (typeof embed.description === 'string') total += embed.description.length
  if (typeof embed.author?.name === 'string') total += embed.author.name.length
  if (typeof embed.footer?.text === 'string') total += embed.footer.text.length
  if (Array.isArray(embed.fields)) {
    for (let i = 0; i < embed.fields.length; i++) {
      if (typeof embed.fields[i].name === 'string') total += embed.fields[i].name.length
      if (typeof embed.fields[i].value === 'string') total += embed.fields[i].value.length
    }
  }
  return total
}

function getEmbedCharLens (embeds) {
  if (!Array.isArray(embeds)) return 0
  let total = 0
  for (const embed of embeds) {
    total += getSingleEmbedCharLen(embed)
  }
  return total
}

function sendBulkLog (senderPkg, embeds, guildSettings) {
  global.bot.executeWebhook(senderPkg.webhookID, senderPkg.webhookToken, {
    file: senderPkg.file ? senderPkg.file : '',
    username: global.bot.user.username,
    avatarURL: global.bot.user.avatarURL,
    embeds,
    allowedMentions: { // even though this is an embed and cannot ping, why not
      everyone: false,
      roles: false,
      users: false
    }
  }).catch(async e => {
    if (e && e.message && e.message.includes('Request timed out')) return
    const codeStr = e && e.code != null ? String(e.code) : ''
    if (codeStr && !(codeStr === '50035' || codeStr === '10015' || codeStr === '500')) {
      global.logger.warn(`Got ${e.code} while sending webhook to ${senderPkg.guildID} (${global.bot.guilds.get(senderPkg.guildID) ? global.bot.guilds.get(senderPkg.guildID).name : 'Could not find guild!'})`)
      // global.webhook.warn(`Got ${e.code} while sending webhook to ${senderPkg.guildID} (${global.bot.guilds.get(senderPkg.guildID) ? global.bot.guilds.get(senderPkg.guildID).name : 'Could not find guild!'})`)
    }
    if (codeStr === '10015') { // Webhook doesn't exist anymore.
      const channelID = guildSettings?.getEventByName?.(senderPkg.eventName)
      if (!channelID) return
      await global.redis.del(`webhook-${channelID}`)
      return await guildWebhookCacher(senderPkg.guildID, channelID)
    } else {
      console.error('Error while sending a message over webhook!', e, senderPkg, senderPkg.embeds?.[0]?.fields)
    }
  })
}
