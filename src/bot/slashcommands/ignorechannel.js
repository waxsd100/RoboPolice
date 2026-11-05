const { ignoreChannel, clearIgnoredChannels } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getAuthorField, getEmbedFooter } = require('../utils/embeds.js')
const { pick } = require('../utils/i18n')

module.exports = {
  name: 'ignorechannel',
  userPerms: ['manageWebhooks', 'manageChannels'],
  botPerms: ['manageWebhooks', 'manageChannels'],
  noThread: true,
  func: async interaction => {
    const listIgnoredChannelsOption = interaction.data.options?.find(o => o.name === 'optional')?.value === 'list'
    const resetIgnoredChannelsOption = interaction.data.options?.find(o => o.name === 'optional')?.value === 'reset'
    if (listIgnoredChannelsOption) {
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: 'ログ対象外のチャンネル', en: 'Channels left out of the logs' }),
          description: global.bot.guildSettingsCache[interaction.guildID].ignoredChannels.map(id => {
            return `<#${id}> (${id})`
          }).join('\n') || pick(interaction, { ja: 'ログの対象外にしているチャンネルはありません。', en: 'No channel is left out of the logs.' }),
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }]
      }).catch(global.logger.error)
    } else if (resetIgnoredChannelsOption) {
      await clearIgnoredChannels(interaction.guildID)
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: 'ログ対象外のチャンネル', en: 'Channels left out of the logs' }),
          description: pick(interaction, { ja: 'すべてのチャンネルをログの対象に戻しました。', en: 'Every channel is logged again.' }),
          color: EMBED_COLORS.GREEN,
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }]
      }).catch(() => {})
    } else {
      const channelOption = interaction.data.options?.find(o => o.name === 'channel-to-ignore')
      if (channelOption && !global.bot.getChannel(channelOption.value)) {
        return interaction.createMessage({
          embeds: [{
            title: pick(interaction, { ja: '失敗', en: 'Failed' }),
            description: pick(interaction, { ja: 'チャンネルが見つかりません。', en: 'Channel not found.' }),
            thumbnail: {
              url: interaction.member.user.dynamicAvatarURL(null, 64)
            },
            color: EMBED_COLORS.RED
          }]
        }).catch(_ => {})
      }
      const channel = channelOption?.value || interaction.channel.id
      const isDisabled = await ignoreChannel(interaction.guildID, channel)
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: '成功', en: 'Done' }),
          description: isDisabled
            ? pick(interaction, { ja: `<#${channel}> をログの対象から外しました。`, en: `<#${channel}> is left out of the logs now.` })
            : pick(interaction, { ja: `<#${channel}> をログの対象に戻しました。`, en: `<#${channel}> is logged again.` }),
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          color: EMBED_COLORS.GREEN
        }]
      })
    }
  }
}
