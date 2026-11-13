const fs = require('fs')
const path = require('path')
const Eris = require('eris')
const { EMBED_COLORS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { NewsThreadChannel, PrivateThreadChannel, PublicThreadChannel } = require('eris')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { langOf, pick } = require('../utils/i18n') // also keeps each interaction's language
const { formatPermissions } = require('../utils/displayLabels')

let slashCommands = fs.readdirSync(path.resolve('src', 'bot', 'slashcommands')).map(filename => {
  return require(path.resolve('src', 'bot', 'slashcommands', filename))
})

const waitingCustomIDs = new Map()
const waitingTimeouts = new Map()

function safePermissionsOf (channel, memberOrId) {
  if (typeof channel?.permissionsOf !== 'function') return null
  const id = typeof memberOrId === 'string'
    ? memberOrId
    : (memberOrId?.user?.id || memberOrId?.id)
  if (id) {
    try {
      const perms = channel.permissionsOf(id)
      if (perms) return perms
    } catch (_) {}
  }
  try {
    return channel.permissionsOf(memberOrId) || null
  } catch (_) {
    return null
  }
}

function replyComponentNotice (interaction, content) {
  if (typeof interaction.createMessage !== 'function') return Promise.resolve()
  return Promise.resolve()
    .then(() => interaction.createMessage({ content, flags: Eris.Constants.MessageFlags.EPHEMERAL }))
    .catch(() => {})
}

module.exports = {
  name: 'interactionCreate',
  type: 'on',
  safePermissionsOf,
  handle (interaction) {
    return new Promise((resolve, reject) => { // why use a promise? awaitCustomID and handle are still sync and can share the timeout/callback maps nicely?
      if (interaction.applicationID !== global.bot.user.id) {
        resolve()
        return
      }
      if (interaction instanceof Eris.ComponentInteraction) {
        if (!interaction.member && !interaction.user) {
          resolve()
          return
        }
        const customID = interaction.data?.custom_id
        const entry = customID ? waitingCustomIDs.get(customID) : null
        if (entry) {
          const clickerID = interaction.member?.user?.id || interaction.member?.id || interaction.user?.id
          if ((entry.userID && entry.userID !== clickerID) || !clickerID) {
            replyComponentNotice(interaction, pick(interaction, {
              ja: `このボタン・メニューは実行した本人（<@${entry.userID}>）のみ操作できます。`,
              en: `Only <@${entry.userID}>, who started this action, can use these controls.`
            })).finally(() => resolve())
            return
          }
          waitingCustomIDs.delete(customID)
          clearTimeout(entry.timer)
          waitingTimeouts.delete(customID)
          Promise.resolve()
            .then(() => typeof interaction.acknowledge === 'function' ? interaction.acknowledge() : undefined)
            .catch(() => {})
            .then(() => {
              entry.run(interaction)
              resolve()
            })
          return
        }
        replyComponentNotice(interaction, pick(interaction, {
          ja: 'このボタン・メニューの有効期限が切れました。もう一度コマンドを実行してください。',
          en: 'These controls have expired. Please run the command again.'
        })).finally(() => resolve())
      } else if (interaction instanceof Eris.CommandInteraction) {
        const cmdName = interaction.data?.name
        const isDmAllowed = ['help', 'invite'].includes(cmdName)
        const actorUser = interaction.member?.user || interaction.user
        if (!isDmAllowed && (!interaction.guildID || !interaction.member)) {
          interaction.createMessage({
            content: pick(interaction, {
              ja: 'このコマンドはサーバー内でのみ使用できます。',
              en: 'This command can only be used in a server.'
            }),
            flags: Eris.Constants.MessageFlags.EPHEMERAL
          }).catch(() => {})
          resolve()
          return
        }
        if (cmdName === 'reloadinteractions' && actorUser && isCreator(actorUser.id)) {
          fs.readdirSync(path.resolve('src', 'bot', 'slashcommands')).forEach(filename => {
            delete require.cache[require.resolve(path.resolve('src', 'bot', 'slashcommands', filename))]
          })
          slashCommands = fs.readdirSync(path.resolve('src', 'bot', 'slashcommands')).map(filename => {
            return require(path.resolve('src', 'bot', 'slashcommands', filename))
          })
          interaction.createMessage({ content: '🆗 reloaded slash commands', flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
          resolve()
          return
        }
        const cachedChannel = interaction.channel?.id ? global.bot.getChannel?.(interaction.channel.id) : null
        const channel = typeof interaction.channel?.permissionsOf === 'function'
          ? interaction.channel
          : (cachedChannel || interaction.channel)
        const command = slashCommands.find(c => c.name === cmdName)
        if (command) {
          if (command?.type === 'creator' && (!actorUser || !isCreator(actorUser.id))) {
            interaction.createMessage({
              content: pick(interaction, { ja: 'このコマンドはBOT開発者専用です。', en: 'This command is only for the bot\'s developers.' }),
              flags: Eris.Constants.MessageFlags.EPHEMERAL
            }).catch(() => {})
            resolve()
            return
          }
          const targetChannel = cachedChannel || interaction.channel
          if (command.noThread && (targetChannel instanceof NewsThreadChannel || targetChannel instanceof PrivateThreadChannel || targetChannel instanceof PublicThreadChannel || [10, 11, 12].includes(targetChannel?.type))) {
            interaction.createMessage({
              embeds: [{
                title: pick(interaction, { ja: '実行できません', en: 'Cannot run here' }),
                color: EMBED_COLORS.YELLOW_ORANGE,
                description: pick(interaction, {
                  ja: `\`/${command.name}\` はスレッド内では使えません。通常のテキストチャンネルで実行してください。`,
                  en: `\`/${command.name}\` cannot be run in a thread. Please run it in a text channel.`
                }),
                footer: getEmbedFooter(global.bot.user),
                author: actorUser ? getAuthorField(actorUser) : undefined,
                thumbnail: actorUser?.dynamicAvatarURL
                  ? { url: actorUser.dynamicAvatarURL(null, 64) }
                  : undefined
              }],
              flags: Eris.Constants.MessageFlags.EPHEMERAL
            }).catch(() => {})
            resolve()
            return
          }
          const subcommand = interaction.data.options?.find(o => o.type === 1 || !('value' in o))?.name
          const userPerms = command.subcommandPerms?.[subcommand]?.userPerms ?? command.userPerms
          const botPerms = command.subcommandPerms?.[subcommand]?.botPerms ?? command.botPerms
          const lang = langOf(interaction)
          const guild = interaction.guildID ? global.bot.guilds.get(interaction.guildID) : null
          if (!isDmAllowed && !guild) {
            global.logger.warn('Interaction was used but the guild ID sent is not in cache!')
            interaction.createMessage({
              content: pick(interaction, {
                ja: 'サーバー情報の読み込み中です。少し待ってからもう一度お試しください。',
                en: 'Server cache is still loading, please try again in a moment.'
              }),
              flags: Eris.Constants.MessageFlags.EPHEMERAL
            }).catch(() => {})
            resolve()
            return
          }
          if (userPerms && userPerms.length !== 0 && interaction.member && !isCreator(actorUser.id) && !hasStaffAccess(interaction.member.roles, guild)) {
            const userChannelPerms = (typeof channel?.permissionsOf === 'function' && safePermissionsOf(channel, interaction.member)?.json) || interaction.member?.permissions?.json || {}
            const missingPermissions = userPerms.filter(bpName => !userChannelPerms[bpName])
            if (missingPermissions.length !== 0) {
              const formatted = formatPermissions(missingPermissions, lang)
              interaction.createMessage({
                embeds: [{
                  title: pick(interaction, { ja: '権限が足りません', en: 'Missing permissions' }),
                  color: EMBED_COLORS.YELLOW_ORANGE,
                  description: pick(interaction, {
                    ja: `\`/${command.name}\` を使うには次の権限が必要です: ${formatted}`,
                    en: `You need these permissions to run \`/${command.name}\`: ${formatted}`
                  }),
                  footer: getEmbedFooter(global.bot.user),
                  author: actorUser ? getAuthorField(actorUser) : undefined,
                  thumbnail: actorUser?.dynamicAvatarURL
                    ? { url: actorUser.dynamicAvatarURL(null, 64) }
                    : undefined
                }],
                flags: Eris.Constants.MessageFlags.EPHEMERAL
              }).catch(() => {})
              resolve()
              return
            }
          }
          if (botPerms && botPerms.length !== 0 && typeof channel?.permissionsOf === 'function') {
            const botChannelPermissions = safePermissionsOf(channel, global.bot.user.id)?.json
            if (botChannelPermissions) {
              const missingPermissions = botPerms.filter(bpName => !botChannelPermissions[bpName])
              if (missingPermissions.length !== 0) {
                const formatted = formatPermissions(missingPermissions, lang)
                interaction.createMessage({
                  embeds: [{
                    title: pick(interaction, { ja: 'BOT の権限が足りません', en: 'The bot is missing permissions' }),
                    color: EMBED_COLORS.YELLOW_ORANGE,
                    description: pick(interaction, {
                      ja: `\`/${command.name}\` を実行するには、このチャンネル（またはサーバー設定）で BOT に次の権限を付与してください: ${formatted}\n\n推奨権限つきの招待リンクは \`/invite\`、現在の権限診断は \`/setup status\` で確認できます。`,
                      en: `I need these permissions in this channel (or server settings) to run \`/${command.name}\`: ${formatted}\n\nSee \`/invite\` for recommended invite links, or \`/setup status\` to check permissions.`
                    }),
                    footer: getEmbedFooter(global.bot.user),
                    author: actorUser ? getAuthorField(actorUser) : undefined,
                    thumbnail: {
                      url: global.bot.user.dynamicAvatarURL(null, 64)
                    }
                  }],
                  flags: Eris.Constants.MessageFlags.EPHEMERAL
                }).catch(() => {})
                resolve()
                return
              }
            }
          }
          if (guild && interaction.member) {
            global.logger.info(`${interaction.member.username}#${interaction.member.discriminator} (${interaction.member.id}) in ${interaction.channel.id} sent /${command.name}. The guild is called "${guild.name}", owned by ${guild.ownerID} and has ${guild.memberCount} members.`)
          } else if (actorUser) {
            global.logger.info(`${actorUser.username}#${actorUser.discriminator} (${actorUser.id}) sent /${command.name} in DM/uncached context.`)
          }
          Promise.resolve()
            .then(() => command.func(interaction))
            .catch(commandError => global.logger.error(commandError))
            .finally(() => resolve())
        } else {
          resolve()
        }
      } else {
        resolve()
      }
    })
  },
  // Stops waiting for `id` without settling its promise, e.g. for the buttons that were not pressed.
  cancelCustomID (id) {
    clearTimeout(waitingTimeouts.get(id))
    waitingTimeouts.delete(id)
    waitingCustomIDs.delete(id)
  },
  awaitCustomID (id, userIDToLock, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waitingCustomIDs.delete(id)
        waitingTimeouts.delete(id)
        reject(new Error(`Custom ID ${id} did not receive a response.`))
      }, timeoutMs)
      timer.unref?.()
      waitingTimeouts.set(id, timer)
      waitingCustomIDs.set(id, {
        userID: userIDToLock,
        timer,
        run: (...toReturn) => {
          if (waitingTimeouts.has(id)) {
            clearTimeout(waitingTimeouts.get(id))
            waitingTimeouts.delete(id)
            waitingCustomIDs.delete(id)
          }
          resolve(...toReturn)
        }
      })
    })
  }
}
