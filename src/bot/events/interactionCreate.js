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

function replyComponentNotice (interaction, content) {
  if (typeof interaction.createMessage !== 'function') return Promise.resolve()
  return Promise.resolve()
    .then(() => interaction.createMessage({ content, flags: Eris.Constants.MessageFlags.EPHEMERAL }))
    .catch(() => {})
}

module.exports = {
  name: 'interactionCreate',
  type: 'on',
  handle (interaction) {
    return new Promise((resolve, reject) => { // why use a promise? awaitCustomID and handle are still sync and can share the timeout/callback maps nicely?
      if (interaction.applicationID !== global.bot.user.id) {
        resolve()
        return
      }
      if (interaction instanceof Eris.ComponentInteraction) {
        const entry = interaction.data?.custom_id ? waitingCustomIDs.get(interaction.data.custom_id) : null
        if (entry) {
          const clickerID = interaction.member?.user?.id || interaction.user?.id
          if (clickerID === entry.userID) {
            interaction.acknowledge().catch(() => {}).then(() => {
              entry.run(interaction)
              resolve()
            })
            return
          }
          replyComponentNotice(interaction, pick(interaction, {
            ja: `このボタン・メニューは実行した本人（<@${entry.userID}>）のみ操作できます。`,
            en: `Only <@${entry.userID}>, who started this action, can use these controls.`
          })).finally(() => resolve())
          return
        }
        replyComponentNotice(interaction, pick(interaction, {
          ja: 'このボタン・メニューの有効期限が切れました。もう一度コマンドを実行してください。',
          en: 'These controls have expired. Please run the command again.'
        })).finally(() => resolve())
      } else if (interaction instanceof Eris.CommandInteraction) {
        const channel = global.bot.getChannel(interaction.channel.id)
        if (!channel || channel instanceof Eris.VoiceChannel) {
          resolve()
          return // no need to check send messages because replies are made using webhooks
        }
        if (interaction.data.name === 'reloadinteractions' && isCreator(interaction.member.user.id)) {
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
        const command = slashCommands.find(c => c.name === interaction.data.name)
        if (command) {
          if (command?.type === 'creator' && !isCreator(interaction.member.user.id)) {
            interaction.createMessage({
              content: pick(interaction, { ja: 'このコマンドはBOT開発者専用です。', en: 'This command is only for the bot\'s developers.' }),
              flags: Eris.Constants.MessageFlags.EPHEMERAL
            }).catch(() => {})
            resolve()
            return
          }
          if (command.noThread && (interaction.channel instanceof NewsThreadChannel || interaction.channel instanceof PrivateThreadChannel || interaction.channel instanceof PublicThreadChannel)) {
            interaction.createMessage({
              embeds: [{
                title: pick(interaction, { ja: '実行できません', en: 'Cannot run here' }),
                color: EMBED_COLORS.YELLOW_ORANGE,
                description: pick(interaction, {
                  ja: `\`/${command.name}\` はスレッド内では使えません。通常のテキストチャンネルで実行してください。`,
                  en: `\`/${command.name}\` cannot be run in a thread. Please run it in a text channel.`
                }),
                footer: getEmbedFooter(global.bot.user),
                author: getAuthorField(interaction.member.user),
                thumbnail: {
                  url: interaction.member.user.dynamicAvatarURL(null, 64)
                }
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
          if (userPerms && userPerms.length !== 0 && !isCreator(interaction.member.user.id) && !hasStaffAccess(interaction.member.roles, global.bot.guilds.get(interaction.guildID))) {
            const userChannelPerms = interaction.channel.permissionsOf(interaction.member.user.id).json
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
                  author: getAuthorField(interaction.member.user),
                  thumbnail: {
                    url: interaction.member.user.dynamicAvatarURL(null, 64)
                  }
                }],
                flags: Eris.Constants.MessageFlags.EPHEMERAL
              }).catch(() => {})
              resolve()
              return
            }
          }
          if (botPerms && botPerms.length !== 0) {
            const botChannelPermissions = interaction.channel.permissionsOf(global.bot.user.id).json
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
                  author: getAuthorField(interaction.member.user),
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
          const guild = global.bot.guilds.get(interaction.guildID)
          if (guild) {
            global.logger.info(`${interaction.member.username}#${interaction.member.discriminator} (${interaction.member.id}) in ${interaction.channel.id} sent /${command.name}. The guild is called "${guild.name}", owned by ${guild.ownerID} and has ${guild.memberCount} members.`)
            Promise.resolve()
              .then(() => command.func(interaction))
              .catch(commandError => global.logger.error(commandError))
              .finally(() => resolve())
          } else {
            global.logger.warn('Interaction was used but the guild ID sent is not in cache!')
            resolve()
          }
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
