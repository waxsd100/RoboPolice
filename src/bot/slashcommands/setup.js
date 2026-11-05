const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { setEventsLogId } = require('../../db/interfaces/postgres/update')
const { EMBED_COLORS, PRESET_EVENT_MAP, ALL_EVENTS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { langOf, pick } = require('../utils/i18n')

// The Japanese text, or its English for an English client.
const EN = {
  すべて: 'All',
  すべてのイベントを記録します: 'Log every event',
  チャンネル関連: 'Channels',
  'チャンネルの作成・削除・更新（名前、権限の上書き）': 'Channels made, deleted or changed (name, permission overwrites)',
  メッセージ関連: 'Messages',
  'メッセージの編集・削除・一括削除（BAN、purge）': 'Messages edited, deleted or deleted in bulk (bans, purges)',
  メンバー更新関連: 'Member changes',
  'ロールの付与・剥奪、ニックネーム変更、サーバーブースト、タイムアウト': 'Roles given or taken, nicknames, server boosts, timeouts',
  モデレーション関連: 'Moderation',
  メンバーのBAN・BAN解除・キック: 'Members banned, unbanned or kicked',
  参加ログ関連: 'Joins and leaves',
  'メンバーの参加・退出（正確な記録にはサーバー管理とチャンネルの管理が必要）': 'Members joining and leaving (Manage Server and Manage Channels for invites)',
  サーバー関連: 'Server',
  'サーバー設定の変更（名前、認証レベルなど）、イベント開始': 'Server settings changed (name, verification level…), events starting',
  ロール関連: 'Roles',
  'ロールの作成・削除・更新（名前、権限）': 'Roles made, deleted or changed (name, permissions)',
  ボイス関連: 'Voice',
  'ボイスチャンネルの参加・退出・移動、サーバーミュート／スピーカーミュート': 'Voice channels joined, left or switched; server mutes and deafens',
  ログ設定ユーティリティ: 'Logging setup',
  '下の選択メニューから、**このチャンネル**へ出力するイベントのプリセットを選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。': 'Choose below the groups of events to log to **this channel**. See `/help guide: Usage` and `/help` for more.',
  '下の選択メニューから、**このチャンネル**へ出力するイベントを個別に選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。': 'Choose below the events to log to **this channel**. See `/help guide: Usage` and `/help` for more.',
  チャンネル作成: 'Channel Create',
  チャンネルが作成されたとき: 'A channel is made',
  チャンネル更新: 'Channel Update',
  チャンネル設定が変更されたとき: 'A channel\'s settings change',
  チャンネル削除: 'Channel Delete',
  チャンネルが削除されたとき: 'A channel is deleted',
  メンバーBAN: 'Member Banned',
  メンバーがBANされたとき: 'A member is banned',
  メンバーBAN解除: 'Member Unbanned',
  メンバーのBANが解除されたとき: 'A member is unbanned',
  ロール作成: 'Role Create',
  ロールが作成されたとき: 'A role is made',
  ロール削除: 'Role Delete',
  ロールが削除されたとき: 'A role is deleted',
  ロール更新: 'Role Update',
  ロールが更新されたとき: 'A role changes',
  サーバー設定変更: 'Server Settings Change',
  サーバー設定が変更されたとき: 'The server\'s settings change',
  サーバー絵文字変更: 'Server Emojis Change',
  絵文字が追加・削除されたとき: 'Emojis are added or removed',
  メッセージ削除: 'Message Delete',
  メッセージが1件削除されたとき: 'A message is deleted',
  メッセージ一括削除: 'Bulk Message Delete',
  メッセージの一括削除やBANに伴う削除が行われたとき: 'Messages are deleted in bulk or with a ban',
  メッセージ編集: 'Message Edit',
  メッセージが編集されたとき: 'A message is edited',
  メンバー参加: 'Member Join',
  メンバーがサーバーに参加したとき: 'A member joins the server',
  メンバーキック: 'Member Kick',
  メンバーがキックされたとき: 'A member is kicked',
  メンバー退出: 'Member Leave',
  メンバーがサーバーから退出したとき: 'A member leaves the server',
  ニックネーム変更: 'Nickname Update',
  'メンバーがニックネームを変更したとき（条件付きで記録されます）': 'A member\'s nickname changes (not always logged)',
  ロール付与・剥奪: 'Role Add/Remove',
  メンバーがロールを付与・剥奪されたとき: 'A member is given or loses a role',
  メンバー認証通過: 'Member Gate Verify',
  メンバーがコミュニティのルールに同意したとき: 'A member agrees to the server\'s rules',
  ボイス退出: 'Voice Channel Leave',
  メンバーがボイスチャンネルから退出したとき: 'A member leaves a voice channel',
  ボイス参加: 'Voice Channel Join',
  メンバーがボイスチャンネルに参加したとき: 'A member joins a voice channel',
  ボイス移動: 'Voice Channel Moved',
  メンバーがボイスチャンネルを移動したとき: 'A member moves to another voice channel',
  ボイスミュート: 'Voice Muted/Deafened',
  メンバーがミュート・スピーカーミュートされたとき: 'A member is server muted or deafened',
  カスタムステータス変更: 'Custom Status Update',
  メンバーがカスタムステータスを変更したとき: 'A member changes their custom status',
  ログ出力チャンネル一覧: 'Logging channels',
  'このサーバーではどのイベントも記録していません。設定方法は `/setup` または `/help` をご覧ください。': 'No event is logged in this server. See `/setup` or `/help` to set it up.'
}
function say (interaction, ja) {
  return langOf(interaction) === 'en' && EN[ja] ? EN[ja] : ja
}

function missingPermissionsText (interaction, missing) {
  const list = missing.map(p => `**${p}**`).join(', ')
  return pick(interaction, {
    ja: `ログ設定を更新できません。このチャンネルで次の権限が必要です: ${list}。詳しくは \`/help guide: 使い方\` をご覧ください。`,
    en: `Could not change the logging settings: the bot needs these permissions in this channel: ${list}. See \`/help guide: Usage\` for more.`
  })
}

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
          label: say(interaction, 'すべて'),
          description: say(interaction, 'すべてのイベントを記録します'),
          value: 'all',
          default: !Object.keys(guildEvents).find(geKey => guildEvents[geKey] !== interaction.channel.id)
        }, {
          label: say(interaction, 'チャンネル関連'),
          description: say(interaction, 'チャンネルの作成・削除・更新（名前、権限の上書き）'),
          value: 'channel',
          default: interaction.channel.id === guildEvents.channelCreate && interaction.channel.id === guildEvents.channelUpdate && interaction.channel.id === guildEvents.channelDelete
        }, {
          label: say(interaction, 'メッセージ関連'),
          description: say(interaction, 'メッセージの編集・削除・一括削除（BAN、purge）'),
          value: 'message',
          default: interaction.channel.id === guildEvents.messageUpdate && interaction.channel.id === guildEvents.messageDelete && interaction.channel.id === guildEvents.messageDeleteBulk
        }, {
          label: say(interaction, 'メンバー更新関連'),
          description: say(interaction, 'ロールの付与・剥奪、ニックネーム変更、サーバーブースト、タイムアウト'),
          value: 'member',
          default: interaction.channel.id === guildEvents.guildMemberUpdate && interaction.channel.id === guildEvents.guildMemberBoostUpdate && interaction.channel.id === guildEvents.guildMemberNickUpdate
        }, {
          label: say(interaction, 'モデレーション関連'),
          description: say(interaction, 'メンバーのBAN・BAN解除・キック'),
          value: 'moderation',
          default: interaction.channel.id === guildEvents.guildBanAdd && interaction.channel.id === guildEvents.guildBanRemove && interaction.channel.id === guildEvents.guildMemberKick
        }, {
          label: say(interaction, '参加ログ関連'),
          description: say(interaction, 'メンバーの参加・退出（正確な記録にはサーバー管理とチャンネルの管理が必要）'),
          value: 'joinlog',
          default: interaction.channel.id === guildEvents.guildMemberAdd && interaction.channel.id === guildEvents.guildMemberRemove
        }, {
          label: say(interaction, 'サーバー関連'),
          description: say(interaction, 'サーバー設定の変更（名前、認証レベルなど）、イベント開始'),
          value: 'server',
          default: interaction.channel.id === guildEvents.guildUpdate
        }, {
          label: say(interaction, 'ロール関連'),
          description: say(interaction, 'ロールの作成・削除・更新（名前、権限）'),
          value: 'role',
          default: interaction.channel.id === guildEvents.guildRoleCreate && interaction.channel.id === guildEvents.guildRoleDelete && interaction.channel.id === guildEvents.guildRoleUpdate
        }, {
          label: say(interaction, 'ボイス関連'),
          description: say(interaction, 'ボイスチャンネルの参加・退出・移動、サーバーミュート／スピーカーミュート'),
          value: 'voice',
          default: interaction.channel.id === guildEvents.voiceChannelLeave && interaction.channel.id === guildEvents.voiceChannelSwitch && interaction.channel.id === guildEvents.voiceStateUpdate && interaction.channel.id === guildEvents.voiceChannelJoin
        }]
      }]
    }]
    const setupEmbed = {
      title: say(interaction, 'ログ設定ユーティリティ'),
      description: say(interaction, '下の選択メニューから、**このチャンネル**へ出力するイベントのプリセットを選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。'),
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
        description: missingPermissionsText(interaction, missingPermissions),
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
          label: say(interaction, 'すべて'),
          description: say(interaction, 'すべてのイベントを記録します'),
          value: 'all',
          default: !Object.keys(guildEvents).find(geKey => guildEvents[geKey] !== interaction.channel.id)
        },
        {
          label: say(interaction, 'チャンネル作成'),
          description: say(interaction, 'チャンネルが作成されたとき'),
          value: 'channelCreate',
          default: guildEvents
            .channelCreate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'チャンネル更新'),
          description: say(interaction, 'チャンネル設定が変更されたとき'),
          value: 'channelUpdate',
          default: guildEvents
            .channelUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'チャンネル削除'),
          description: say(interaction, 'チャンネルが削除されたとき'),
          value: 'channelDelete',
          default: guildEvents
            .channelDelete ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーBAN'),
          description: say(interaction, 'メンバーがBANされたとき'),
          value: 'guildBanAdd',
          default: guildEvents
            .guildBanAdd ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーBAN解除'),
          description: say(interaction, 'メンバーのBANが解除されたとき'),
          value: 'guildBanRemove',
          default: guildEvents
            .guildBanRemove ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ロール作成'),
          description: say(interaction, 'ロールが作成されたとき'),
          value: 'guildRoleCreate',
          default: guildEvents
            .guildRoleCreate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ロール削除'),
          description: say(interaction, 'ロールが削除されたとき'),
          value: 'guildRoleDelete',
          default: guildEvents
            .guildRoleDelete ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ロール更新'),
          description: say(interaction, 'ロールが更新されたとき'),
          value: 'guildRoleUpdate',
          default: guildEvents
            .guildRoleUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'サーバー設定変更'),
          description:
            say(interaction, 'サーバー設定が変更されたとき'),

          value: 'guildUpdate',
          default: guildEvents
            .guildUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'サーバー絵文字変更'),
          description:
            say(interaction, '絵文字が追加・削除されたとき'),
          value: 'guildEmojisUpdate',
          default: guildEvents
            .guildEmojisUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ削除'),
          description:
            say(interaction, 'メッセージが1件削除されたとき'),

          value: 'messageDelete',
          default: guildEvents
            .messageDelete ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ一括削除'),
          description:
            say(interaction, 'メッセージの一括削除やBANに伴う削除が行われたとき'),
          value: 'messageDeleteBulk',
          default: guildEvents
            .messageDeleteBulk ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ編集'),
          description: say(interaction, 'メッセージが編集されたとき'),
          value: 'messageUpdate',
          default: guildEvents
            .messageUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー参加'),
          description:
            say(interaction, 'メンバーがサーバーに参加したとき'),
          value: 'guildMemberAdd',
          default: guildEvents
            .guildMemberAdd ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーキック'),
          description: say(interaction, 'メンバーがキックされたとき'),
          value: 'guildMemberKick',
          default: guildEvents
            .guildMemberKick ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー退出'),
          description:
            say(interaction, 'メンバーがサーバーから退出したとき'),
          value: 'guildMemberRemove',
          default: guildEvents
            .guildMemberRemove ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ニックネーム変更'),
          description:
            say(interaction, 'メンバーがニックネームを変更したとき（条件付きで記録されます）'),
          value: 'guildMemberNickUpdate',
          default: guildEvents
            .guildMemberNickUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ロール付与・剥奪'),
          description:
            say(interaction, 'メンバーがロールを付与・剥奪されたとき'),
          value: 'guildMemberUpdate',
          default: guildEvents
            .guildMemberUpdate ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー認証通過'),
          description:
            say(interaction, 'メンバーがコミュニティのルールに同意したとき'),
          value: 'guildMemberVerify',
          default: guildEvents
            .guildMemberVerify ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス退出'),
          description:
            say(interaction, 'メンバーがボイスチャンネルから退出したとき'),
          value: 'voiceChannelLeave',
          default: guildEvents
            .voiceChannelLeave ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス参加'),
          description:
            say(interaction, 'メンバーがボイスチャンネルに参加したとき'),
          value: 'voiceChannelJoin',
          default: guildEvents.voiceChannelJoin ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス移動'),
          description:
            say(interaction, 'メンバーがボイスチャンネルを移動したとき'),
          value: 'voiceChannelSwitch',
          default: guildEvents.voiceChannelSwitch ===
            interaction.channel.id
        },
        {
          label: say(interaction, 'ボイスミュート'),
          description:
            say(interaction, 'メンバーがミュート・スピーカーミュートされたとき'),
          value: 'voiceStateUpdate',
          default: guildEvents.voiceStateUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'カスタムステータス変更'),
          description: say(interaction, 'メンバーがカスタムステータスを変更したとき'),
          value: 'presenceUpdate',
          default: guildEvents.presenceUpdate === interaction.channel.id
        }
        ]
      }]
    }]
    const setupEmbed = {
      title: say(interaction, 'ログ設定ユーティリティ'),
      description: say(interaction, '下の選択メニューから、**このチャンネル**へ出力するイベントを個別に選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。'),
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
        description: missingPermissionsText(interaction, missingPermissions),
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
      title: say(interaction, 'ログ出力チャンネル一覧'),
      author: getAuthorField(interaction.member.user),
      description: logLines.length !== 0 ? logLines.join('\n') : say(interaction, 'このサーバーではどのイベントも記録していません。設定方法は `/setup` または `/help` をご覧ください。'),
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
