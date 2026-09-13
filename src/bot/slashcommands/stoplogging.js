const Eris = require('eris')
const { clearEventByID, setAllEventsOneId } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getAuthorField, getEmbedFooter } = require('../utils/embeds.js')

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
          title: '成功',
          description: 'すべてのイベントの出力先を解除しました。ログの記録を停止します。',
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
            title: '警告',
            description: `<#${channelToStopLogging || interaction.channel.id}> に出力しているイベントはありません。現在の設定は \`/setup list\` で確認できます。`,
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
          description: `All events logging to <#${channelToStopLogging || interaction.channel.id}> (${channelToStopLogging || interaction.channel.id}) の出力先をすべて解除しました。`,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          fields: [{
            name: '解除したイベント',
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
