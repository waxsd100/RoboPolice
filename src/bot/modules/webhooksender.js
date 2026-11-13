const webhookCache = require('./webhookcache')
const guildWebhookCacher = require('./guildWebhookCacher')
const cacheGuild = require('../utils/cacheGuild')
const enqueue = require('./bulkqueue')
const setEventsByChannelID = require('../../db/interfaces/postgres/update').setEventsLogId

function clampStr (str, max) {
  const s = String(str ?? '')
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)
  return `${cut}…`
}

function sanitizeEmbeds (embeds) {
  if (!Array.isArray(embeds)) return []
  return embeds.slice(0, 10).map(embed => {
    if (!embed) return embed
    if (embed.title != null) embed.title = clampStr(embed.title, 256)
    if (embed.description != null) embed.description = clampStr(embed.description, 4096)
    if (embed.author?.name != null) embed.author.name = clampStr(embed.author.name, 256)
    if (embed.footer?.text != null) embed.footer.text = clampStr(embed.footer.text, 2048)
    if (Array.isArray(embed.fields)) {
      embed.fields = embed.fields.slice(0, 25).map(field => ({
        ...field,
        name: clampStr(field.name || '-', 256) || '-',
        value: clampStr(field.value ?? '-', 1024) || '-'
      }))
    }
    return embed
  })
}

module.exports = async pkg => {
  if (!pkg || !pkg.guildID) return global.logger.error('No guildID was provided in an embed!')
  if (!Array.isArray(pkg.embeds) || pkg.embeds.length === 0) return
  if (!pkg.embeds[0].color) pkg.embeds[0].color = 3553599 // todo: make a function to check all the following logic for EACH embed, not just the first
  const guild = global.bot.guilds.get(pkg.guildID)
  if (!guild) {
    console.error('Invalid guild ID sent in package!', pkg.guildID, pkg, pkg.embeds)
    // global.webhook.warn(`Invalid guild ID sent in package! ${pkg.guildID} (I am not a member anymore!)`)
    return
  }
  let guildSettings = global.bot.guildSettingsCache[pkg.guildID]
  if (!guildSettings) {
    await cacheGuild(pkg.guildID)
    guildSettings = global.bot.guildSettingsCache[pkg.guildID]
    if (!guildSettings) return
  }
  const channelID = guildSettings.getEventByName(pkg.eventName)
  if (!channelID) return
  const logChannel = global.bot.getChannel(channelID)
  if (!logChannel) {
    await global.redis.del(`webhook-${channelID}`)
    await setEventsByChannelID(pkg.guildID, '', [pkg.eventName])
    await cacheGuild(pkg.guildID)
    return
  }
  let botPerms
  try {
    botPerms = logChannel.permissionsOf(global.bot.user.id)?.json
  } catch (_) {}
  if (!botPerms?.manageWebhooks || botPerms.viewChannel === false) return

  let webhook = await webhookCache.getWebhook(channelID)
  let webhookID, webhookToken
  if (!webhook && channelID) {
    await guildWebhookCacher(pkg.guildID, channelID)
    webhook = await webhookCache.getWebhook(channelID)
  }
  if (webhook) {
    const split = webhook.split('|')
    webhookID = split[0]
    webhookToken = split[1]
  }
  if (webhook) {
    if (!pkg.embeds[0].footer && !pkg.noFooter) {
      pkg.embeds[0].footer = {
        text: `${global.bot.user.username}#${global.bot.user.discriminator}`,
        icon_url: global.bot.user.avatarURL
      }
    }
    if (!pkg.embeds[0].timestamp) {
      pkg.embeds[0].timestamp = new Date()
    }
    pkg.embeds = sanitizeEmbeds(pkg.embeds)

    // Thanks for the help, De Morgan's laws.
    if (pkg.file || (guild.memberCount < 10000 && guild.voiceStates.size < 100)) {
      global.bot.executeWebhook(webhookID, webhookToken, {
        file: pkg.file ? pkg.file : '',
        username: global.bot.user.username,
        avatarURL: global.bot.user.avatarURL,
        embeds: pkg.embeds,
        allowedMentions: { // even though this is an embed and cannot ping, why not
          everyone: false,
          roles: false,
          users: false
        }
      }).catch(async e => {
        if (e && e.message && (e.message.includes('Request timed out') || e.message.includes('503 Service Temporarily') || e.message.includes('Internal Server Error'))) return
        const codeStr = e && e.code != null ? String(e.code) : ''
        if (codeStr && !(codeStr === '50035' || codeStr === '10015' || codeStr === '500' || codeStr === '503' || (e && e.message && e.message.includes('Internal Server Error')))) {
          global.logger.warn(`Got ${e.code} while sending webhook to ${pkg.guildID} (${global.bot.guilds.get(pkg.guildID) ? global.bot.guilds.get(pkg.guildID).name : 'Could not find guild!'})`)
          // global.webhook.warn(`Got ${e.code} while sending webhook to ${pkg.guildID} (${global.bot.guilds.get(pkg.guildID) ? global.bot.guilds.get(pkg.guildID).name : 'Could not find guild!'})`)
        }
        if (codeStr === '10015') { // Webhook doesn't exist anymore.
          await global.redis.del(`webhook-${guildSettings.getEventByName(pkg.eventName)}`)
          return await guildWebhookCacher(pkg.guildID, guildSettings.getEventByName(pkg.eventName))
        } else {
          global.logger.error('Error while sending a message over webhook!', e, pkg, pkg.embeds[0]?.fields)
        }
      })
    } else {
      pkg.webhookID = webhookID
      pkg.webhookToken = webhookToken
      enqueue(pkg, guildSettings)
    }
  }
}
