const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { setEventsLogId } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS, PRESET_EVENT_MAP, ALL_EVENTS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')

async function returnMissingPerms (channelID, userID, events) {
  const requiredPerms = ['manageWebhooks', 'viewAuditLog', 'viewChannel', 'sendMessages', 'embedLinks', 'readMessageHistory', 'useExternalEmojis']
  let logChannelPerms
  try {
    const logChannel = global.bot.getChannel(channelID)
    logChannelPerms = logChannel.permissionsOf(userID)?.json
  } catch (_) {
    // missing channel
    return
  }
  return requiredPerms.filter(rp => !logChannelPerms[rp])
}

async function handlePresetSetup (interaction, recursionUUID) {
  const { awaitCustomID } = require('../events/interactionCreate')
  const guildEvents = global.bot.guildSettingsCache[interaction.guildID].getEventLogRaw()
  const followupUUID = recursionUUID || uuidv4()
  try {
    const components = [{
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: [{
        type: Eris.Constants.ComponentTypes.SELECT_MENU,
        custom_id: followupUUID,
        max_values: 9,
        min_values: 0,
        options: [{
          label: 'すべて',
          description: 'すべてのイベントを記録します',
          value: 'all',
          default: !Object.keys(guildEvents).find(geKey => guildEvents[geKey] !== interaction.channel.id)
        }, {
          label: 'チャンネル関連',
          description: 'チャンネルの作成・削除・更新（名前、権限の上書き）',
          value: 'channel',
          default: interaction.channel.id === guildEvents.channelCreate && interaction.channel.id === guildEvents.channelUpdate && interaction.channel.id === guildEvents.channelDelete
        }, {
          label: 'メッセージ関連',
          description: 'メッセージの編集・削除・一括削除（BAN、purge）',
          value: 'message',
          default: interaction.channel.id === guildEvents.messageUpdate && interaction.channel.id === guildEvents.messageDelete && interaction.channel.id === guildEvents.messageDeleteBulk
        }, {
          label: 'メンバー更新関連',
          description: 'ロールの付与・剥奪、ニックネーム変更、サーバーブースト、タイムアウト',
          value: 'member',
          default: interaction.channel.id === guildEvents.guildMemberUpdate && interaction.channel.id === guildEvents.guildMemberBoostUpdate && interaction.channel.id === guildEvents.guildMemberNickUpdate
        }, {
          label: 'モデレーション関連',
          description: 'メンバーのBAN・BAN解除・キック',
          value: 'moderation',
          default: interaction.channel.id === guildEvents.guildBanAdd && interaction.channel.id === guildEvents.guildBanRemove && interaction.channel.id === guildEvents.guildMemberKick
        }, {
          label: '参加ログ関連',
          description: 'メンバーの参加・退出（正確な記録にはサーバー管理とチャンネルの管理が必要）',
          value: 'joinlog',
          default: interaction.channel.id === guildEvents.guildMemberAdd && interaction.channel.id === guildEvents.guildMemberRemove
        }, {
          label: 'サーバー関連',
          description: 'サーバー設定の変更（名前、認証レベルなど）、イベント開始',
          value: 'server',
          default: interaction.channel.id === guildEvents.guildUpdate
        }, {
          label: 'ロール関連',
          description: 'ロールの作成・削除・更新（名前、権限）',
          value: 'role',
          default: interaction.channel.id === guildEvents.guildRoleCreate && interaction.channel.id === guildEvents.guildRoleDelete && interaction.channel.id === guildEvents.guildRoleUpdate
        }, {
          label: 'ボイス関連',
          description: 'ボイスチャンネルの参加・退出・移動、サーバーミュート／スピーカーミュート',
          value: 'voice',
          default: interaction.channel.id === guildEvents.voiceChannelLeave && interaction.channel.id === guildEvents.voiceChannelSwitch && interaction.channel.id === guildEvents.voiceStateUpdate && interaction.channel.id === guildEvents.voiceChannelJoin
        }]
      }]
    }]
    const setupEmbed = {
      title: 'ログ設定ユーティリティ',
      description: '下の選択メニューから、**このチャンネル**へ出力するイベントのプリセットを選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。',
      color: EMBED_COLORS.PURPLED_BLUE,
      thumbnail: {
        url: interaction.member.user.dynamicAvatarURL(null, 64)
      }
    }
    if (recursionUUID) {
      await interaction.editOriginalMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    } else {
      await interaction.createMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    }
  } catch (e) {
    global.logger.error('error handling preset menu', e)
    return
  }

  let buttonResponse

  try {
    buttonResponse = await awaitCustomID(followupUUID, interaction.member.user.id)
  } catch (_) {
    return
  }

  let eventsToLog = []
  let eventsToRemove = []

  for (const presetName in PRESET_EVENT_MAP) {
    for (const eventName of PRESET_EVENT_MAP[presetName]) {
      if (buttonResponse.data.values?.includes(presetName)) {
        if (presetName === 'all') {
          eventsToLog = ALL_EVENTS
          eventsToRemove = []
          break
        } else {
          eventsToLog.push(eventName)
        }
      } else if (guildEvents[eventName] === interaction.channel.id && presetName !== 'all') {
        eventsToRemove.push(eventName)
      }
    }
  }

  const missingPermissions = await returnMissingPerms(interaction.channel.id, global.bot.user.id, eventsToLog)
  if (!missingPermissions) return // null is returned if the log channel cannot be found
  else if (missingPermissions.length !== 0) {
    await interaction.editOriginalMessage({
      embeds: [{
        thumbnail: {
          url: global.bot.user.dynamicAvatarURL(null, 64)
        },
        description: `ログ設定を更新できません。このチャンネルで次の権限が必要です: ${missingPermissions.map(p => `**${p}**`).join(', ')}。詳しくは \`/help usage: Guide\` をご覧ください。`,
        color: EMBED_COLORS.YELLOW_ORANGE,
        footer: getEmbedFooter(global.bot.user),
        author: getAuthorField(interaction.member.user)
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
    return
  }

  try {
    await setEventsLogId(interaction.guildID, interaction.channel.id, eventsToLog)
    await setEventsLogId(interaction.guildID, '', eventsToRemove)
  } catch (e) {
    global.logger.error('Setup failure to update guild document settings for guild', interaction.guildID, e)
    return
  }
  handlePresetSetup(interaction, followupUUID)
}

async function handleIndividualSetup (interaction, recursionUUID) {
  const { awaitCustomID } = require('../events/interactionCreate')
  const guildEvents = global.bot.guildSettingsCache[interaction.guildID].getEventLogRaw()
  const followupUUID = recursionUUID || uuidv4()
  try {
    const components = [{
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: [{
        type: Eris.Constants.ComponentTypes.SELECT_MENU,
        custom_id: followupUUID,
        max_values: 24,
        min_values: 0,
        options: [{
          label: 'すべて',
          description: 'すべてのイベントを記録します',
          value: 'all',
          default: !Object.keys(guildEvents).find(geKey => guildEvents[geKey] !== interaction.channel.id)
        },
        {
          label: 'チャンネル作成',
          description: 'チャンネルが作成されたとき',
          value: 'channelCreate',
          default: guildEvents
            .channelCreate ===
            interaction.channel.id
        },
        {
          label: 'チャンネル更新',
          description: 'チャンネル設定が変更されたとき',
          value: 'channelUpdate',
          default: guildEvents
            .channelUpdate ===
            interaction.channel.id
        },
        {
          label: 'チャンネル削除',
          description: 'チャンネルが削除されたとき',
          value: 'channelDelete',
          default: guildEvents
            .channelDelete ===
            interaction.channel.id
        },
        {
          label: 'メンバーBAN',
          description: 'メンバーがBANされたとき',
          value: 'guildBanAdd',
          default: guildEvents
            .guildBanAdd ===
            interaction.channel.id
        },
        {
          label: 'メンバーBAN解除',
          description: 'メンバーのBANが解除されたとき',
          value: 'guildBanRemove',
          default: guildEvents
            .guildBanRemove ===
            interaction.channel.id
        },
        {
          label: 'ロール作成',
          description: 'ロールが作成されたとき',
          value: 'guildRoleCreate',
          default: guildEvents
            .guildRoleCreate ===
            interaction.channel.id
        },
        {
          label: 'ロール削除',
          description: 'ロールが削除されたとき',
          value: 'guildRoleDelete',
          default: guildEvents
            .guildRoleDelete ===
            interaction.channel.id
        },
        {
          label: 'ロール更新',
          description: 'ロールが更新されたとき',
          value: 'guildRoleUpdate',
          default: guildEvents
            .guildRoleUpdate ===
            interaction.channel.id
        },
        {
          label: 'サーバー設定変更',
          description:
            'サーバー設定が変更されたとき',

          value: 'guildUpdate',
          default: guildEvents
            .guildUpdate ===
            interaction.channel.id
        },
        {
          label: 'サーバー絵文字変更',
          description:
            '絵文字が追加・削除されたとき',
          value: 'guildEmojisUpdate',
          default: guildEvents
            .guildEmojisUpdate ===
            interaction.channel.id
        },
        {
          label: 'メッセージ削除',
          description:
            'メッセージが1件削除されたとき',

          value: 'messageDelete',
          default: guildEvents
            .messageDelete ===
            interaction.channel.id
        },
        {
          label: 'メッセージ一括削除',
          description:
            'メッセージの一括削除やBANに伴う削除が行われたとき',
          value: 'messageDeleteBulk',
          default: guildEvents
            .messageDeleteBulk ===
            interaction.channel.id
        },
        {
          label: 'メッセージ編集',
          description: 'メッセージが編集されたとき',
          value: 'messageUpdate',
          default: guildEvents
            .messageUpdate ===
            interaction.channel.id
        },
        {
          label: 'メンバー参加',
          description:
            'メンバーがサーバーに参加したとき',
          value: 'guildMemberAdd',
          default: guildEvents
            .guildMemberAdd ===
            interaction.channel.id
        },
        {
          label: 'メンバーキック',
          description: 'メンバーがキックされたとき',
          value: 'guildMemberKick',
          default: guildEvents
            .guildMemberKick ===
            interaction.channel.id
        },
        {
          label: 'メンバー退出',
          description:
            'メンバーがサーバーから退出したとき',
          value: 'guildMemberRemove',
          default: guildEvents
            .guildMemberRemove ===
            interaction.channel.id
        },
        {
          label: 'ニックネーム変更',
          description:
            'メンバーがニックネームを変更したとき（条件付きで記録されます）',
          value: 'guildMemberNickUpdate',
          default: guildEvents
            .guildMemberNickUpdate ===
            interaction.channel.id
        },
        {
          label: 'ロール付与・剥奪',
          description:
            'メンバーがロールを付与・剥奪されたとき',
          value: 'guildMemberUpdate',
          default: guildEvents
            .guildMemberUpdate ===
            interaction.channel.id
        },
        {
          label: 'メンバー認証通過',
          description:
            'メンバーがコミュニティのルールに同意したとき',
          value: 'guildMemberVerify',
          default: guildEvents
            .guildMemberVerify ===
            interaction.channel.id
        },
        {
          label: 'ボイス退出',
          description:
            'メンバーがボイスチャンネルから退出したとき',
          value: 'voiceChannelLeave',
          default: guildEvents
            .voiceChannelLeave ===
            interaction.channel.id
        },
        {
          label: 'ボイス参加',
          description:
            'メンバーがボイスチャンネルに参加したとき',
          value: 'voiceChannelJoin',
          default: guildEvents.voiceChannelJoin ===
            interaction.channel.id
        },
        {
          label: 'ボイス移動',
          description:
            'メンバーがボイスチャンネルを移動したとき',
          value: 'voiceChannelSwitch',
          default: guildEvents.voiceChannelSwitch ===
            interaction.channel.id
        },
        {
          label: 'ボイスミュート',
          description:
            'メンバーがミュート・スピーカーミュートされたとき',
          value: 'voiceStateUpdate',
          default: guildEvents.voiceStateUpdate === interaction.channel.id
        },
        {
          label: 'カスタムステータス変更',
          description: 'メンバーがカスタムステータスを変更したとき',
          value: 'presenceUpdate',
          default: guildEvents.presenceUpdate === interaction.channel.id
        }
        ]
      }]
    }]
    const setupEmbed = {
      title: 'ログ設定ユーティリティ',
      description: '下の選択メニューから、**このチャンネル**へ出力するイベントを個別に選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。',
      color: EMBED_COLORS.PURPLED_BLUE,
      thumbnail: {
        url: interaction.member.user.dynamicAvatarURL(null, 64)
      }
    }
    if (recursionUUID) {
      await interaction.editOriginalMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    } else {
      await interaction.createMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    }
  } catch (e) {
    global.logger.error('Error handling preset menu', e)
    return
  }

  let buttonResponse

  try {
    buttonResponse = await awaitCustomID(followupUUID, interaction.member.user.id)
  } catch (_) {
    return
  }

  let eventsToLog = []
  let eventsToRemove = []

  if (buttonResponse.data.values?.includes('all')) {
    eventsToLog = ALL_EVENTS
    eventsToRemove = []
  } else {
    for (const eventName of ALL_EVENTS) {
      if (buttonResponse.data.values?.includes(eventName)) {
        eventsToLog.push(eventName)
      } else if (guildEvents[eventName] === interaction.channel.id) {
        eventsToRemove.push(eventName)
      }
    }
  }

  const missingPermissions = await returnMissingPerms(interaction.channel.id, global.bot.user.id, eventsToLog)
  if (!missingPermissions) return // null is returned if the log channel cannot be found
  else if (missingPermissions.length !== 0) {
    await interaction.editOriginalMessage({
      embeds: [{
        thumbnail: {
          url: global.bot.user.dynamicAvatarURL(null, 64)
        },
        description: `ログ設定を更新できません。このチャンネルで次の権限が必要です: ${missingPermissions.map(p => `**${p}**`).join(', ')}。詳しくは \`/help usage: Guide\` をご覧ください。`,
        color: EMBED_COLORS.YELLOW_ORANGE,
        footer: getEmbedFooter(global.bot.user),
        author: getAuthorField(interaction.member.user)
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
    return
  }

  try {
    await setEventsLogId(interaction.guildID, interaction.channel.id, eventsToLog)
    await setEventsLogId(interaction.guildID, '', eventsToRemove)
  } catch (e) {
    global.logger.error('Setup failure to update guild document settings for guild', interaction.guildID, e)
    return
  }
  handleIndividualSetup(interaction, followupUUID)
}

async function handleListLogSetup (interaction) {
  const logLines = []
  for (const eventName of ALL_EVENTS) {
    if (global.bot.guildSettingsCache[interaction.guildID].getEventLogID(eventName)) {
      const logIdForEvent = global.bot.guildSettingsCache[interaction.guildID].getEventLogID(eventName)
      logLines.push(`${eventName}: <#${logIdForEvent}> (${logIdForEvent})`)
    }
  }
  interaction.createMessage({
    embeds: [{
      title: 'ログ出力チャンネル一覧',
      author: getAuthorField(interaction.member.user),
      description: logLines.length !== 0 ? logLines.join('\n') : 'このサーバーではどのイベントも記録していません。設定方法は `/setup` または `/help` をご覧ください。',
      color: EMBED_COLORS.PURPLED_BLUE
    }],
    flags: Eris.Constants.MessageFlags.EPHEMERAL
  }).catch(() => {})
}

module.exports = {
  name: 'setup',
  userPerms: ['manageWebhooks', 'manageChannels', 'viewAuditLogs'],
  botPerms: ['manageWebhooks', 'viewAuditLogs'],
  noThread: true,
  func: async interaction => {
    if (interaction.data.options?.find(o => o.name === 'via_presets')) {
      await handlePresetSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'via_individual_event')) {
      await handleIndividualSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'list')) {
      await handleListLogSetup(interaction)
    }
  }
}
