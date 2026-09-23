const Eris = require('eris')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')

module.exports = async message => {
  if (message.author.bot || !message.member || message.channel instanceof Eris.TextVoiceChannel) return
  if (message.content.startsWith(process.env.GLOBAL_BOT_PREFIX)) {
    const cmd = message.content.substring(process.env.GLOBAL_BOT_PREFIX.length).split(' ')[0].toLowerCase()
    const splitSuffix = message.content.substr(process.env.GLOBAL_BOT_PREFIX).split(' ')
    const suffix = splitSuffix.slice(1, splitSuffix.length).join(' ')
    processCommand(message, cmd, suffix)
  }
}

function processCommand (message, commandName, suffix) {
  const command = global.bot.commands[commandName]
  if (!command) return
  const bp = message.channel.permissionsOf(global.bot.user.id).json
  if (!bp.viewChannel || !bp.sendMessages) return
  if ((command.noDM || command.perm || command.type === 'admin') && !message.channel.guild) {
    message.channel.createMessage('このコマンドはDMでは使用できません。')
    return
  } else if (command.noThread && (message.channel.type === 10 || message.channel.type === 11 || message.channel.type === 12)) {
    message.channel.createMessage('このコマンドはスレッド内では使用できません。')
    return
  } else if (isCreator(message.author.id)) {
    global.logger.info(`Developer override by ${message.author.username}#${message.author.discriminator} at ${new Date().toUTCString()}`)
    command.func(message, suffix)
    return
  } else if (command.type === 'creator' && !isCreator(message.author.id)) {
    message.channel.createMessage('このコマンドはBOT開発者専用です。')
    return
  } else if (command.type === 'admin' && !(message.member.permissions.has('administrator') || message.author.id === message.channel.guild.ownerID || hasStaffAccess(message.member.roles, message.channel.guild))) {
    message.channel.createMessage('このコマンドは管理者専用です。使用には「管理者」権限が必要です。')
    return
  } else if (command.perm && !(message.member.permissions.has(command.perm) || message.author.id === message.channel.guild.ownerID || hasStaffAccess(message.member.roles, message.channel.guild))) {
    message.channel.createMessage(`このコマンドの使用には、サーバーのオーナーであるか ${command.perm} 権限が必要です。`)
    return
  } else if (command.perms && message.author.id !== message.channel.guild.ownerID && !hasStaffAccess(message.member.roles, message.channel.guild) && command.perms.find(p => !message.member.permissions.has(p))) {
    message.channel.createMessage(`このコマンドの使用には、サーバーのオーナーであるか次の権限が必要です: ${command.perms.join(', ')}`)
    return
  }
  global.logger.info(`${message.author.username}#${message.author.discriminator} (${message.author.id}) in ${message.channel.id} sent ${commandName} with the args "${suffix}". The guild is called "${message.channel.guild.name}", owned by ${message.channel.guild.ownerID} and has ${message.channel.guild.memberCount} members.`)
  command.func(message, suffix)
}
