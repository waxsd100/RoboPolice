const Eris = require('eris')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { formatPermission, formatPermissions } = require('../utils/displayLabels')

module.exports = async message => {
  if (!message?.author || message.author.bot || !message.channel) return
  if (Eris.TextVoiceChannel && message.channel instanceof Eris.TextVoiceChannel) return
  const prefix = process.env.GLOBAL_BOT_PREFIX
  if (!prefix || typeof message.content !== 'string' || !message.content.startsWith(prefix)) return
  const rest = message.content.substring(prefix.length)
  const parts = rest.split(/\s+/)
  if (!parts[0]) return
  const cmd = parts[0].toLowerCase()
  const suffix = rest.substring(parts[0].length).trim()
  await processCommand(message, cmd, suffix)
}

async function processCommand (message, commandName, suffix) {
  const command = global.bot.commands?.[commandName]
  if (!command) return
  if (message.channel.guild) {
    if (!message.member) return
    const bp = typeof message.channel.permissionsOf === 'function'
      ? message.channel.permissionsOf(global.bot.user.id)?.json
      : null
    if (bp && (!bp.viewChannel || !bp.sendMessages)) return
  }
  if ((command.noDM || command.perm || command.perms || command.type === 'admin') && !message.channel.guild) {
    await message.channel.createMessage('このコマンドはDMでは使用できません。').catch(() => {})
    return
  } else if (command.noThread && (message.channel.type === 10 || message.channel.type === 11 || message.channel.type === 12)) {
    await message.channel.createMessage('このコマンドはスレッド内では使用できません。').catch(() => {})
    return
  } else if (isCreator(message.author.id)) {
    global.logger.info(`Developer override by ${message.author.username}#${message.author.discriminator} at ${new Date().toUTCString()}`)
    await Promise.resolve(command.func(message, suffix)).catch(err => global.logger?.error?.(err))
    return
  } else if (command.type === 'creator' && !isCreator(message.author.id)) {
    await message.channel.createMessage('このコマンドはBOT開発者専用です。').catch(() => {})
    return
  } else if (command.type === 'admin' && !(message.member?.permissions?.has?.('administrator') || message.author.id === message.channel.guild.ownerID || hasStaffAccess(message.member?.roles, message.channel.guild))) {
    await message.channel.createMessage('このコマンドは管理者専用です。使用には **管理者** 権限が必要です。').catch(() => {})
    return
  } else if (command.perm && !(message.member?.permissions?.has?.(command.perm) || message.author.id === message.channel.guild.ownerID || hasStaffAccess(message.member?.roles, message.channel.guild))) {
    await message.channel.createMessage(`このコマンドの使用には、サーバーのオーナーであるか **${formatPermission(command.perm, 'ja')}** 権限が必要です。`).catch(() => {})
    return
  } else if (command.perms && message.author.id !== message.channel.guild.ownerID && !hasStaffAccess(message.member?.roles, message.channel.guild) && command.perms.find(p => !message.member?.permissions?.has?.(p))) {
    const missing = command.perms.filter(p => !message.member?.permissions?.has?.(p))
    await message.channel.createMessage(`このコマンドの使用には、サーバーのオーナーであるか次の権限が必要です: ${formatPermissions(missing, 'ja')}`).catch(() => {})
    return
  }
  if (message.channel.guild) {
    global.logger.info(`${message.author.username}#${message.author.discriminator} (${message.author.id}) in ${message.channel.id} sent ${commandName} with the args "${suffix}". The guild is called "${message.channel.guild.name}", owned by ${message.channel.guild.ownerID} and has ${message.channel.guild.memberCount} members.`)
  } else {
    global.logger.info(`${message.author.username}#${message.author.discriminator} (${message.author.id}) in DM ${message.channel.id} sent ${commandName} with the args "${suffix}".`)
  }
  await Promise.resolve(command.func(message, suffix)).catch(err => global.logger?.error?.(err))
}
