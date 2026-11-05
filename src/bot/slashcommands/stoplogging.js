const Eris = require('eris')
const { clearEventByID, setAllEventsOneId } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getAuthorField, getEmbedFooter } = require('../utils/embeds.js')
const { pick } = require('../utils/i18n')

module.exports = {
  name: 'stoplogging',
  botPerms: ['manageWebhooks', 'manageChannels'],
  userPerms: ['manageWebhooks', 'manageChannels'],
  noThread: true,
  func: async interaction => {
    const channelToStopLogging = interaction.data.options?.find(o => o.name === 'channel')?.value
    const shouldStopLoggingEverything = interaction.data.options?.find(o => o.name === 'other')
    if (shouldStopLoggingEverything) {
      await setAllEventsOneId(interaction.guildID, '')
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: '成功', en: 'Done' }),
          description: pick(interaction, { ja: 'すべてのイベントの出力先を解除しました。ログの記録を止めます。', en: 'No event is logged anywhere now: logging has stopped.' }),
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.GREEN,
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    } else {
      const eventsLoggingHere = global.bot.guildSettingsCache[interaction.guildID].eventLogByNames(channelToStopLogging || interaction.channel.id)
      if (eventsLoggingHere.length === 0) {
        interaction.createMessage({
          embeds: [{
            title: pick(interaction, { ja: '警告', en: 'Warning' }),
            description: pick(interaction, { ja: `<#${channelToStopLogging || interaction.channel.id}> に出力しているイベントはありません。今の設定は \`/setup list\` で確認できます。`, en: `No event is logged to <#${channelToStopLogging || interaction.channel.id}>. See the settings with \`/setup list\`.` }),
            thumbnail: {
              url: interaction.member.user.dynamicAvatarURL(null, 64)
            },
            color: EMBED_COLORS.YELLOW_ORANGE,
            author: getAuthorField(interaction.member.user),
            footer: getEmbedFooter(global.bot.user)
          }],
          flags: Eris.Constants.MessageFlags.EPHEMERAL
        }).catch(() => {})
        return
      }
      await clearEventByID(interaction.guildID, channelToStopLogging || interaction.channel.id)
      interaction.createMessage({
        embeds: [{
          description: pick(interaction, { ja: `<#${channelToStopLogging || interaction.channel.id}> (${channelToStopLogging || interaction.channel.id}) への出力をすべて解除しました。`, en: `Nothing is logged to <#${channelToStopLogging || interaction.channel.id}> (${channelToStopLogging || interaction.channel.id}) now.` }),
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          fields: [{
            name: pick(interaction, { ja: '解除したイベント', en: 'Events stopped' }),
            value: eventsLoggingHere.join(', ')
          }],
          color: EMBED_COLORS.GREEN,
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    }
  }
}
