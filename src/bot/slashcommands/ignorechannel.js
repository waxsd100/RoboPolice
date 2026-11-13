const Eris = require('eris')
const { ignoreChannel, clearIgnoredChannels } = require('../../db/interfaces/postgres/update')
const cacheGuild = require('../utils/cacheGuild')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getAuthorField, getEmbedFooter } = require('../utils/embeds.js')
const { pick } = require('../utils/i18n')

module.exports = {
  name: 'ignorechannel',
  userPerms: ['manageWebhooks', 'manageChannels'],
  botPerms: ['manageWebhooks', 'manageChannels'],
  noThread: true,
  func: async interaction => {
    if (!global.bot.guildSettingsCache?.[interaction.guildID]) {
      await cacheGuild(interaction.guildID).catch(() => {})
    }
    if (!global.bot.guildSettingsCache?.[interaction.guildID]) {
      return interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: '失敗', en: 'Failed' }),
          description: pick(interaction, { ja: 'サーバー設定を読み込めませんでした。', en: 'Could not load server settings.' }),
          color: EMBED_COLORS.RED
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    }
    const listIgnoredChannelsOption = interaction.data.options?.find(o => o.name === 'optional')?.value === 'list'
    const resetIgnoredChannelsOption = interaction.data.options?.find(o => o.name === 'optional')?.value === 'reset'
    if (listIgnoredChannelsOption) {
      const rawDescription = (global.bot.guildSettingsCache[interaction.guildID].ignoredChannels || []).map(id => {
        return `<#${id}> (${id})`
      }).join('\n') || pick(interaction, { ja: 'ログの対象外にしているチャンネルはありません。', en: 'No channel is left out of the logs.' })
      const description = rawDescription.length > 4096 ? `${rawDescription.slice(0, 4095)}…` : rawDescription
      interaction.createMessage({
        embeds: [{
          title: pick(interaction, { ja: 'ログ対象外のチャンネル', en: 'Channels left out of the logs' }),
          description,
          color: EMBED_COLORS.PURPLED_BLUE,
          author: getAuthorField(interaction.member.user),
          footer: getEmbedFooter(global.bot.user)
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
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
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    } else {
      const channelOption = interaction.data.options?.find(o => o.name === 'channel-to-ignore')
      const targetID = typeof channelOption?.value === 'string' ? channelOption.value : channelOption?.value?.id
      const resolvedOption = (targetID && interaction.data.resolved?.channels?.[targetID]) || (typeof channelOption?.value === 'object' ? channelOption.value : null)
      const resolved = channelOption
        ? (global.bot.getChannel(targetID) || resolvedOption)
        : (global.bot.getChannel(interaction.channel.id) || interaction.channel)
      const resolvedGuildID = resolved?.guild?.id || resolved?.guildID || resolved?.guild_id
      if ((channelOption && !resolved) || (resolvedGuildID && resolvedGuildID !== interaction.guildID)) {
        return interaction.createMessage({
          embeds: [{
            title: pick(interaction, { ja: '失敗', en: 'Failed' }),
            description: pick(interaction, { ja: 'チャンネルが見つかりません。', en: 'Channel not found.' }),
            thumbnail: {
              url: interaction.member.user.dynamicAvatarURL(null, 64)
            },
            color: EMBED_COLORS.RED
          }],
          flags: Eris.Constants.MessageFlags.EPHEMERAL
        }).catch(_ => {})
      }
      const channel = targetID || interaction.channel.id
      const isDisabled = await ignoreChannel(interaction.guildID, channel)
      if (isDisabled === null) {
        return interaction.createMessage({
          embeds: [{
            title: pick(interaction, { ja: '失敗', en: 'Failed' }),
            description: pick(interaction, { ja: 'チャンネルが見つかりません。', en: 'Channel not found.' }),
            thumbnail: {
              url: interaction.member.user.dynamicAvatarURL(null, 64)
            },
            color: EMBED_COLORS.RED
          }],
          flags: Eris.Constants.MessageFlags.EPHEMERAL
        }).catch(_ => {})
      }
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
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    }
  }
}
