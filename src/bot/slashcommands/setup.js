const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const update = require('../../db/interfaces/postgres/update')
const replySettings = require('../../db/interfaces/postgres/replySettings')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const emojiDescriber = require('../modules/emojiDescriber')
const { DEFAULT_REPLY_LENGTH } = require('../modules/eventDrafter')
const { rulesChannels } = require('../modules/serverRules')
const cacheGuild = require('../utils/cacheGuild')
const { EMBED_COLORS, PRESET_EVENT_MAP, ALL_EVENTS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { formatPermissions, formatEventName } = require('../utils/displayLabels')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { isOwnerGuild } = require('../utils/priority')
const { langOf, pick } = require('../utils/i18n')
const { handleAssistantSetup } = require('../modules/assistantSetup')

const MENU_TIMEOUT_MS = 5 * 60 * 1000

function clampStr (str, max) {
  const s = String(str ?? '')
  if (s.length <= max) return s
  let cut = s.slice(0, max - 1)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1)
  return `${cut}…`
}

function clampEmbed (embed) {
  if (!embed) return embed
  if (embed.description != null) embed.description = clampStr(embed.description, 4096)
  if (embed.title != null) embed.title = clampStr(embed.title, 256)
  if (Array.isArray(embed.fields)) {
    embed.fields = embed.fields.slice(0, 25).map(f => ({
      ...f,
      name: clampStr(f.name || '-', 256),
      value: clampStr(f.value || '-', 1024)
    }))
  }
  return embed
}

async function ensureGuildSettings (guildID) {
  if (!guildID) return null
  if (!global.bot.guildSettingsCache?.[guildID]) {
    try {
      await cacheGuild(guildID)
    } catch (e) {
      global.logger?.warn?.(`Failed to cache guild ${guildID}:`, e)
    }
  }
  return global.bot.guildSettingsCache?.[guildID] || null
}

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
  サーバースタンプ変更: 'Server Stickers Change',
  スタンプが追加・更新・削除されたとき: 'Stickers are added, updated or removed',
  サーバーブースト: 'Server Boost',
  メンバーがサーバーブーストを開始・終了したとき: 'A member starts or stops boosting the server',
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
  const lang = langOf(interaction)
  const list = formatPermissions(missing, lang)
  return pick(interaction, {
    ja: `ログ設定を更新できません。このチャンネルで BOT に次の権限が必要です: ${list}。詳しくは \`/setup status\` または \`/help guide: 使い方・初期設定\` をご覧ください。`,
    en: `Could not change the logging settings: the bot needs these permissions in this channel: ${list}. See \`/setup status\` or \`/help guide: Usage & Initial Setup\` for more.`
  })
}

async function returnMissingPerms (channelID, userID) {
  const requiredPerms = ['manageWebhooks', 'viewAuditLog', 'viewChannel', 'sendMessages', 'embedLinks', 'readMessageHistory', 'useExternalEmojis']
  const { safePermissionsOf } = require('../events/interactionCreate')
  const logChannel = global.bot.getChannel(channelID)
  if (!logChannel) return
  const logChannelPerms = safePermissionsOf(logChannel, userID)?.json
  if (!logChannelPerms) return
  return requiredPerms.filter(rp => !logChannelPerms[rp])
}

// Whether nothing is logged to this channel yet: then every event is chosen to begin with.
function nothingLogsHere (guildEvents, channelID) {
  return !Object.values(guildEvents).includes(channelID)
}

function activeCountHere (guildEvents, channelID) {
  return ALL_EVENTS.filter(eventName => guildEvents[eventName] === channelID).length
}

function channelLogField (interaction, guildEvents, channelID) {
  const count = activeCountHere(guildEvents, channelID)
  const otherChannels = new Set(Object.values(guildEvents).filter(id => id && id !== channelID)).size
  const currentText = count === 0
    ? pick(interaction, { ja: '未設定（まだ出力していません）', en: 'None yet' })
    : count === ALL_EVENTS.length
      ? pick(interaction, { ja: `すべてのイベント（${ALL_EVENTS.length} 種類）`, en: `All events (${ALL_EVENTS.length})` })
      : pick(interaction, { ja: `${count} 種類のイベント`, en: `${count} event(s)` })
  const otherText = otherChannels > 0
    ? pick(interaction, { ja: `\n（ほか ${otherChannels} チャンネルでも出力中）`, en: `\n(${otherChannels} other channel(s) also log events)` })
    : ''
  return {
    name: pick(interaction, { ja: 'このチャンネルの現在の出力', en: 'Currently logged here' }),
    value: `${currentText}${otherText}`
  }
}

function savedBanner (interaction, channelID, count) {
  if (count > 0) {
    return pick(interaction, {
      ja: `✅ **保存しました** — <#${channelID}> に **${count} 種類**のイベントを記録します。`,
      en: `✅ **Saved** — logging **${count}** event(s) to <#${channelID}>.`
    })
  }
  return pick(interaction, {
    ja: `✅ **保存しました** — <#${channelID}> へのログ出力を解除しました。`,
    en: `✅ **Saved** — stopped logging to <#${channelID}>.`
  })
}

// Action row with "Save as selected" first (for new channels where "All" is pre-selected) plus
// navigation buttons to switch setup modes without re-typing /setup.
function saveRow (interaction, uuid, mode) {
  const switchLabel = mode === 'preset'
    ? pick(interaction, { ja: '個別に選ぶ', en: 'Choose one by one' })
    : pick(interaction, { ja: 'まとめて選ぶ', en: 'Choose in groups' })
  return {
    type: Eris.Constants.ComponentTypes.ACTION_ROW,
    components: [
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.PRIMARY,
        custom_id: `${uuid}:save`,
        label: pick(interaction, { ja: 'このまま保存', en: 'Save as selected' })
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.SECONDARY,
        custom_id: `${uuid}:switch`,
        label: switchLabel
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.SECONDARY,
        custom_id: `${uuid}:assistant`,
        label: pick(interaction, { ja: 'AIの設定', en: 'AI settings' })
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.SECONDARY,
        custom_id: `${uuid}:status`,
        label: pick(interaction, { ja: '設定状況を確認', en: 'Setup status' })
      }
    ]
  }
}

function saveHint (interaction) {
  return pick(interaction, {
    ja: '何も記録していないチャンネルでは、最初から「すべて」を選んであります。選んだまま保存するときは「このまま保存」を押してください。',
    en: 'In a channel that logs nothing yet, "All" is chosen to begin with. Press "Save as selected" to keep what is chosen.'
  })
}

// Waits for a choice in the menu, the save button, or one of the mode-switch buttons.
async function awaitSetupAction (uuid, userID, components) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const mainMenu = components[0]?.components?.[0]
  const extraMenu = components.find(r => r.components?.[0]?.custom_id === `${uuid}:extra`)?.components?.[0]
  const mainDefaults = mainMenu ? mainMenu.options.filter(o => o.default).map(o => o.value) : []
  const extraDefaults = extraMenu ? extraMenu.options.filter(o => o.default).map(o => o.value) : []
  const ids = [uuid, ...(extraMenu ? [`${uuid}:extra`] : []), `${uuid}:save`, `${uuid}:switch`, `${uuid}:assistant`, `${uuid}:status`]
  try {
    return await Promise.any([
      awaitCustomID(uuid, userID, MENU_TIMEOUT_MS).then(res => ({
        action: 'select',
        values: [...(res?.data?.values || []), ...extraDefaults]
      })),
      ...(extraMenu
        ? [awaitCustomID(`${uuid}:extra`, userID, MENU_TIMEOUT_MS).then(res => ({
            action: 'select',
            values: [...mainDefaults.filter(v => v !== 'all'), ...(res?.data?.values || [])]
          }))]
        : []),
      awaitCustomID(`${uuid}:save`, userID, MENU_TIMEOUT_MS).then(() => ({
        action: 'select',
        values: [...mainDefaults, ...extraDefaults]
      })),
      awaitCustomID(`${uuid}:switch`, userID, MENU_TIMEOUT_MS).then(() => ({ action: 'switch' })),
      awaitCustomID(`${uuid}:assistant`, userID, MENU_TIMEOUT_MS).then(() => ({ action: 'assistant' })),
      awaitCustomID(`${uuid}:status`, userID, MENU_TIMEOUT_MS).then(() => ({ action: 'status' }))
    ])
  } finally {
    for (const id of ids) cancelCustomID(id)
  }
}

function getMemberChannelPerms (interaction) {
  const member = interaction.member
  if (!member) return {}
  const { safePermissionsOf } = require('../events/interactionCreate')
  return safePermissionsOf(interaction.channel, member)?.json ||
    safePermissionsOf(global.bot?.getChannel?.(interaction.channel?.id), member)?.json ||
    member.permissions?.json ||
    {}
}

function mayCheckOrChangeLogs (interaction) {
  const member = interaction.member
  if (!member?.user) return false
  if (isCreator(member.user.id)) return true
  const guild = global.bot.guilds?.get?.(interaction.guildID)
  if (guild && (guild.ownerID === member.user.id || hasStaffAccess(member.roles, guild))) return true
  const perms = getMemberChannelPerms(interaction)
  return Boolean(perms.manageWebhooks && perms.manageChannels && perms.viewAuditLog)
}

function mayViewStatus (interaction) {
  if (mayCheckOrChangeLogs(interaction)) return true
  const perms = getMemberChannelPerms(interaction)
  return Boolean(perms.manageGuild || perms.manageChannels || perms.manageWebhooks || perms.viewAuditLog || perms.administrator)
}

function groupLogsByChannel (guildSettings, lang) {
  const raw = guildSettings?.getEventLogRaw?.() || {}
  const byChannel = new Map()
  for (const eventName of ALL_EVENTS) {
    const channelId = raw[eventName]
    if (!channelId) continue
    if (!byChannel.has(channelId)) byChannel.set(channelId, [])
    byChannel.get(channelId).push(eventName)
  }
  const lines = []
  for (const [channelId, events] of byChannel.entries()) {
    if (events.length === ALL_EVENTS.length) {
      lines.push(lang === 'en'
        ? `<#${channelId}> — **All events (${ALL_EVENTS.length})**`
        : `<#${channelId}> — **すべてのイベント（${ALL_EVENTS.length} 種類）**`)
    } else {
      const names = events.map(e => formatEventName(e, lang))
      const shown = names.slice(0, 8).join(lang === 'en' ? ', ' : '、')
      const more = names.length > 8
        ? (lang === 'en' ? ` …and ${names.length - 8} more` : ` …ほか ${names.length - 8} 件`)
        : ''
      lines.push(lang === 'en'
        ? `<#${channelId}> — **${events.length} event(s)**: ${shown}${more}`
        : `<#${channelId}> — **${events.length} 種類**: ${shown}${more}`)
    }
  }
  return lines
}

async function handlePresetSetup (interaction, recursionOrOpts) {
  const opts = typeof recursionOrOpts === 'string'
    ? { recursionUUID: recursionOrOpts }
    : (recursionOrOpts || {})
  const followupUUID = opts.recursionUUID || uuidv4()
  const asEdit = Boolean(opts.recursionUUID || opts.asEdit)
  const guildSettings = await ensureGuildSettings(interaction.guildID)
  if (!guildSettings) {
    const msg = pick(interaction, {
      ja: 'サーバー設定を読み込めませんでした。もう一度お試しください。',
      en: 'Could not load server settings. Please try again.'
    })
    if (asEdit && typeof interaction.editOriginalMessage === 'function') {
      await interaction.editOriginalMessage({ content: msg, embeds: [], components: [] }).catch(() => {})
    } else {
      await interaction.createMessage({ content: msg, flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
    }
    return
  }
  const guildEvents = guildSettings.getEventLogRaw() || {}
  let components
  try {
    components = [{
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
          default: ALL_EVENTS.every(ev => guildEvents[ev] === interaction.channel.id) || nothingLogsHere(guildEvents, interaction.channel.id)
        }, {
          label: say(interaction, 'チャンネル関連'),
          description: say(interaction, 'チャンネルの作成・削除・更新（名前、権限の上書き）'),
          value: 'channel',
          default: PRESET_EVENT_MAP.channel.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'メッセージ関連'),
          description: say(interaction, 'メッセージの編集・削除・一括削除（BAN、purge）'),
          value: 'message',
          default: PRESET_EVENT_MAP.message.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'メンバー更新関連'),
          description: say(interaction, 'ロールの付与・剥奪、ニックネーム変更、サーバーブースト、タイムアウト'),
          value: 'member',
          default: PRESET_EVENT_MAP.member.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'モデレーション関連'),
          description: say(interaction, 'メンバーのBAN・BAN解除・キック'),
          value: 'moderation',
          default: PRESET_EVENT_MAP.moderation.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, '参加ログ関連'),
          description: say(interaction, 'メンバーの参加・退出（正確な記録にはサーバー管理とチャンネルの管理が必要）'),
          value: 'joinlog',
          default: PRESET_EVENT_MAP.joinlog.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'サーバー関連'),
          description: say(interaction, 'サーバー設定の変更（名前、認証レベルなど）、イベント開始'),
          value: 'server',
          default: PRESET_EVENT_MAP.server.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'ロール関連'),
          description: say(interaction, 'ロールの作成・削除・更新（名前、権限）'),
          value: 'role',
          default: PRESET_EVENT_MAP.role.every(ev => guildEvents[ev] === interaction.channel.id)
        }, {
          label: say(interaction, 'ボイス関連'),
          description: say(interaction, 'ボイスチャンネルの参加・退出・移動、サーバーミュート／スピーカーミュート'),
          value: 'voice',
          default: PRESET_EVENT_MAP.voice.every(ev => guildEvents[ev] === interaction.channel.id)
        }]
      }]
    }, saveRow(interaction, followupUUID, 'preset')]
    const intro = `${say(interaction, '下の選択メニューから、**このチャンネル**へ出力するイベントのプリセットを選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。')}\n\n${saveHint(interaction)}`
    const setupEmbed = clampEmbed({
      title: say(interaction, 'ログ設定ユーティリティ'),
      description: opts.savedNote ? `${opts.savedNote}\n\n${intro}` : intro,
      color: opts.savedNote ? EMBED_COLORS.GREEN : EMBED_COLORS.PURPLED_BLUE,
      fields: [channelLogField(interaction, guildEvents, interaction.channel.id)],
      thumbnail: {
        url: interaction.member.user.dynamicAvatarURL(null, 64)
      }
    })
    if (asEdit) {
      await interaction.editOriginalMessage({ content: '', embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    } else {
      await interaction.createMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    }
  } catch (e) {
    global.logger.error('error handling preset menu', e)
    return
  }

  let result
  try {
    result = await awaitSetupAction(followupUUID, interaction.member.user.id, components)
  } catch (_) {
    return
  }

  if (result.action === 'switch') return handleIndividualSetup(interaction, { asEdit: true })
  if (result.action === 'assistant') return handleAssistantSetup(interaction, { asEdit: true })
  if (result.action === 'status') return handleStatusSetup(interaction, { asEdit: true })

  let eventsToLog = []
  let eventsToRemove = []

  if (result.values.includes('all')) {
    eventsToLog = [...ALL_EVENTS]
    eventsToRemove = []
  } else {
    for (const presetName in PRESET_EVENT_MAP) {
      if (presetName === 'all') continue
      for (const eventName of PRESET_EVENT_MAP[presetName]) {
        if (result.values.includes(presetName)) eventsToLog.push(eventName)
        else if (guildEvents[eventName] === interaction.channel.id) eventsToRemove.push(eventName)
      }
    }
  }

  const missingPermissions = await returnMissingPerms(interaction.channel.id, global.bot.user.id)
  if (!missingPermissions) return // null is returned if the log channel cannot be found
  else if (missingPermissions.length !== 0) {
    await interaction.editOriginalMessage({
      embeds: [clampEmbed({
        thumbnail: {
          url: global.bot.user.dynamicAvatarURL(null, 64)
        },
        description: missingPermissionsText(interaction, missingPermissions),
        color: EMBED_COLORS.YELLOW_ORANGE,
        footer: getEmbedFooter(global.bot.user),
        author: getAuthorField(interaction.member.user)
      })],
      components: [],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
    return
  }

  try {
    await update.setEventsLogId(interaction.guildID, interaction.channel.id, eventsToLog)
    await update.setEventsLogId(interaction.guildID, '', eventsToRemove)
  } catch (e) {
    global.logger.error('Setup failure to update guild document settings for guild', interaction.guildID, e)
    return
  }
  const uniqueLogged = [...new Set(eventsToLog)].length
  return handlePresetSetup(interaction, {
    asEdit: true,
    savedNote: savedBanner(interaction, interaction.channel.id, uniqueLogged)
  })
}

async function handleIndividualSetup (interaction, recursionOrOpts) {
  const opts = typeof recursionOrOpts === 'string'
    ? { recursionUUID: recursionOrOpts }
    : (recursionOrOpts || {})
  const followupUUID = opts.recursionUUID || uuidv4()
  const asEdit = Boolean(opts.recursionUUID || opts.asEdit)
  const guildSettings = await ensureGuildSettings(interaction.guildID)
  if (!guildSettings) {
    const msg = pick(interaction, {
      ja: 'サーバー設定を読み込めませんでした。もう一度お試しください。',
      en: 'Could not load server settings. Please try again.'
    })
    if (asEdit && typeof interaction.editOriginalMessage === 'function') {
      await interaction.editOriginalMessage({ content: msg, embeds: [], components: [] }).catch(() => {})
    } else {
      await interaction.createMessage({ content: msg, flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
    }
    return
  }
  const guildEvents = guildSettings.getEventLogRaw() || {}
  let components
  try {
    components = [{
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: [{
        type: Eris.Constants.ComponentTypes.SELECT_MENU,
        custom_id: followupUUID,
        max_values: 25,
        min_values: 0,
        options: [{
          label: say(interaction, 'すべて'),
          description: say(interaction, 'すべてのイベントを記録します'),
          value: 'all',
          default: ALL_EVENTS.every(ev => guildEvents[ev] === interaction.channel.id) || nothingLogsHere(guildEvents, interaction.channel.id)
        },
        {
          label: say(interaction, 'チャンネル作成'),
          description: say(interaction, 'チャンネルが作成されたとき'),
          value: 'channelCreate',
          default: guildEvents.channelCreate === interaction.channel.id
        },
        {
          label: say(interaction, 'チャンネル更新'),
          description: say(interaction, 'チャンネル設定が変更されたとき'),
          value: 'channelUpdate',
          default: guildEvents.channelUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'チャンネル削除'),
          description: say(interaction, 'チャンネルが削除されたとき'),
          value: 'channelDelete',
          default: guildEvents.channelDelete === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーBAN'),
          description: say(interaction, 'メンバーがBANされたとき'),
          value: 'guildBanAdd',
          default: guildEvents.guildBanAdd === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーBAN解除'),
          description: say(interaction, 'メンバーのBANが解除されたとき'),
          value: 'guildBanRemove',
          default: guildEvents.guildBanRemove === interaction.channel.id
        },
        {
          label: say(interaction, 'ロール作成'),
          description: say(interaction, 'ロールが作成されたとき'),
          value: 'guildRoleCreate',
          default: guildEvents.guildRoleCreate === interaction.channel.id
        },
        {
          label: say(interaction, 'ロール削除'),
          description: say(interaction, 'ロールが削除されたとき'),
          value: 'guildRoleDelete',
          default: guildEvents.guildRoleDelete === interaction.channel.id
        },
        {
          label: say(interaction, 'ロール更新'),
          description: say(interaction, 'ロールが更新されたとき'),
          value: 'guildRoleUpdate',
          default: guildEvents.guildRoleUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'サーバー設定変更'),
          description: say(interaction, 'サーバー設定が変更されたとき'),
          value: 'guildUpdate',
          default: guildEvents.guildUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'サーバー絵文字変更'),
          description: say(interaction, '絵文字が追加・削除されたとき'),
          value: 'guildEmojisUpdate',
          default: guildEvents.guildEmojisUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ削除'),
          description: say(interaction, 'メッセージが1件削除されたとき'),
          value: 'messageDelete',
          default: guildEvents.messageDelete === interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ一括削除'),
          description: say(interaction, 'メッセージの一括削除やBANに伴う削除が行われたとき'),
          value: 'messageDeleteBulk',
          default: guildEvents.messageDeleteBulk === interaction.channel.id
        },
        {
          label: say(interaction, 'メッセージ編集'),
          description: say(interaction, 'メッセージが編集されたとき'),
          value: 'messageUpdate',
          default: guildEvents.messageUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー参加'),
          description: say(interaction, 'メンバーがサーバーに参加したとき'),
          value: 'guildMemberAdd',
          default: guildEvents.guildMemberAdd === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバーキック'),
          description: say(interaction, 'メンバーがキックされたとき'),
          value: 'guildMemberKick',
          default: guildEvents.guildMemberKick === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー退出'),
          description: say(interaction, 'メンバーがサーバーから退出したとき'),
          value: 'guildMemberRemove',
          default: guildEvents.guildMemberRemove === interaction.channel.id
        },
        {
          label: say(interaction, 'ニックネーム変更'),
          description: say(interaction, 'メンバーがニックネームを変更したとき（条件付きで記録されます）'),
          value: 'guildMemberNickUpdate',
          default: guildEvents.guildMemberNickUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'ロール付与・剥奪'),
          description: say(interaction, 'メンバーがロールを付与・剥奪されたとき'),
          value: 'guildMemberUpdate',
          default: guildEvents.guildMemberUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'メンバー認証通過'),
          description: say(interaction, 'メンバーがコミュニティのルールに同意したとき'),
          value: 'guildMemberVerify',
          default: guildEvents.guildMemberVerify === interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス退出'),
          description: say(interaction, 'メンバーがボイスチャンネルから退出したとき'),
          value: 'voiceChannelLeave',
          default: guildEvents.voiceChannelLeave === interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス参加'),
          description: say(interaction, 'メンバーがボイスチャンネルに参加したとき'),
          value: 'voiceChannelJoin',
          default: guildEvents.voiceChannelJoin === interaction.channel.id
        },
        {
          label: say(interaction, 'ボイス移動'),
          description: say(interaction, 'メンバーがボイスチャンネルを移動したとき'),
          value: 'voiceChannelSwitch',
          default: guildEvents.voiceChannelSwitch === interaction.channel.id
        },
        {
          label: say(interaction, 'ボイスミュート'),
          description: say(interaction, 'メンバーがミュート・スピーカーミュートされたとき'),
          value: 'voiceStateUpdate',
          default: guildEvents.voiceStateUpdate === interaction.channel.id
        },
        {
          label: say(interaction, 'カスタムステータス変更'),
          description: say(interaction, 'メンバーがカスタムステータスを変更したとき'),
          value: 'presenceUpdate',
          default: guildEvents.presenceUpdate === interaction.channel.id
        }]
      }]
    }, {
      type: Eris.Constants.ComponentTypes.ACTION_ROW,
      components: [{
        type: Eris.Constants.ComponentTypes.SELECT_MENU,
        custom_id: `${followupUUID}:extra`,
        placeholder: pick(interaction, {
          ja: '追加のイベント（スタンプ・サーバーブースト）',
          en: 'More events (stickers, server boosts)'
        }),
        max_values: 2,
        min_values: 0,
        options: [{
          label: say(interaction, 'サーバースタンプ変更'),
          description: say(interaction, 'スタンプが追加・更新・削除されたとき'),
          value: 'guildStickersUpdate',
          default: guildEvents.guildStickersUpdate === interaction.channel.id
        }, {
          label: say(interaction, 'サーバーブースト'),
          description: say(interaction, 'メンバーがサーバーブーストを開始・終了したとき'),
          value: 'guildMemberBoostUpdate',
          default: guildEvents.guildMemberBoostUpdate === interaction.channel.id
        }]
      }]
    }, saveRow(interaction, followupUUID, 'individual')]
    const intro = `${say(interaction, '下の選択メニューから、**このチャンネル**へ出力するイベントを個別に選んでください。詳しい使い方は `/help guide: Usage` と `/help` をご覧ください。')}\n\n${saveHint(interaction)}`
    const setupEmbed = clampEmbed({
      title: say(interaction, 'ログ設定ユーティリティ'),
      description: opts.savedNote ? `${opts.savedNote}\n\n${intro}` : intro,
      color: opts.savedNote ? EMBED_COLORS.GREEN : EMBED_COLORS.PURPLED_BLUE,
      fields: [channelLogField(interaction, guildEvents, interaction.channel.id)],
      thumbnail: {
        url: interaction.member.user.dynamicAvatarURL(null, 64)
      }
    })
    if (asEdit) {
      await interaction.editOriginalMessage({ content: '', embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    } else {
      await interaction.createMessage({ embeds: [setupEmbed], flags: Eris.Constants.MessageFlags.EPHEMERAL, components })
    }
  } catch (e) {
    global.logger.error('Error handling individual event menu', e)
    return
  }

  let result
  try {
    result = await awaitSetupAction(followupUUID, interaction.member.user.id, components)
  } catch (_) {
    return
  }

  if (result.action === 'switch') return handlePresetSetup(interaction, { asEdit: true })
  if (result.action === 'assistant') return handleAssistantSetup(interaction, { asEdit: true })
  if (result.action === 'status') return handleStatusSetup(interaction, { asEdit: true })

  let eventsToLog = []
  let eventsToRemove = []

  if (result.values.includes('all')) {
    eventsToLog = [...ALL_EVENTS]
    eventsToRemove = []
  } else {
    for (const eventName of ALL_EVENTS) {
      if (result.values.includes(eventName)) {
        eventsToLog.push(eventName)
      } else if (guildEvents[eventName] === interaction.channel.id) {
        eventsToRemove.push(eventName)
      }
    }
  }

  const missingPermissions = await returnMissingPerms(interaction.channel.id, global.bot.user.id)
  if (!missingPermissions) return // null is returned if the log channel cannot be found
  else if (missingPermissions.length !== 0) {
    await interaction.editOriginalMessage({
      embeds: [clampEmbed({
        thumbnail: {
          url: global.bot.user.dynamicAvatarURL(null, 64)
        },
        description: missingPermissionsText(interaction, missingPermissions),
        color: EMBED_COLORS.YELLOW_ORANGE,
        footer: getEmbedFooter(global.bot.user),
        author: getAuthorField(interaction.member.user)
      })],
      components: [],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
    return
  }

  try {
    await update.setEventsLogId(interaction.guildID, interaction.channel.id, eventsToLog)
    await update.setEventsLogId(interaction.guildID, '', eventsToRemove)
  } catch (e) {
    global.logger.error('Setup failure to update guild document settings for guild', interaction.guildID, e)
    return
  }
  return handleIndividualSetup(interaction, {
    asEdit: true,
    savedNote: savedBanner(interaction, interaction.channel.id, eventsToLog.length)
  })
}

async function handleListLogSetup (interaction) {
  const lang = langOf(interaction)
  const guildSettings = await ensureGuildSettings(interaction.guildID)
  const grouped = groupLogsByChannel(guildSettings, lang)
  const ignored = guildSettings?.ignoredChannels || []
  const logBots = Boolean(guildSettings?.isLogBots?.())
  const fields = [
    {
      name: pick(interaction, { ja: 'ログ対象外のチャンネル（/ignorechannel）', en: 'Ignored channels (/ignorechannel)' }),
      value: ignored.length ? ignored.map(id => `<#${id}>`).join('・') : pick(interaction, { ja: 'なし', en: 'None' }),
      inline: true
    },
    {
      name: pick(interaction, { ja: '他のBOTの記録（/logbots）', en: 'Other bots\' messages (/logbots)' }),
      value: logBots
        ? pick(interaction, { ja: 'オン（編集・削除も記録）', en: 'On (edits & deletions logged)' })
        : pick(interaction, { ja: 'オフ（初期値）', en: 'Off (default)' }),
      inline: true
    }
  ]
  interaction.createMessage({
    embeds: [clampEmbed({
      title: say(interaction, 'ログ出力チャンネル一覧'),
      author: getAuthorField(interaction.member.user),
      description: grouped.length !== 0
        ? grouped.join('\n')
        : say(interaction, 'このサーバーではどのイベントも記録していません。設定方法は `/setup` または `/help` をご覧ください。'),
      fields,
      color: EMBED_COLORS.PURPLED_BLUE,
      footer: getEmbedFooter(global.bot.user)
    })],
    flags: Eris.Constants.MessageFlags.EPHEMERAL
  }).catch(() => {})
}

function buildPermissionCheckField (interaction, missingInChannel) {
  const lang = langOf(interaction)
  const guild = global.bot.guilds?.get?.(interaction.guildID)
  const me = guild?.members?.get?.(global.bot.user.id)
  const hasInvitePerms = Boolean(me?.permissions?.has?.('manageGuild') && me?.permissions?.has?.('manageChannels'))
  const hasManageEvents = Boolean(me?.permissions?.has?.('manageEvents'))
  const channelCheck = !missingInChannel || missingInChannel.length === 0
    ? pick(interaction, {
      ja: `✅ **このチャンネルへのログ出力**: 準備OK（<#${interaction.channel.id}>）`,
      en: `✅ **Logging to this channel**: Ready (<#${interaction.channel.id}>)`
    })
    : pick(interaction, {
      ja: `⚠️ **このチャンネルへのログ出力**: <#${interaction.channel.id}> で ${formatPermissions(missingInChannel, lang)} が不足しています`,
      en: `⚠️ **Logging to this channel**: Missing ${formatPermissions(missingInChannel, lang)} in <#${interaction.channel.id}>`
    })
  const inviteCheck = hasInvitePerms
    ? pick(interaction, { ja: '✅ **招待リンク追跡**: 有効', en: '✅ **Invite tracking**: Ready' })
    : pick(interaction, {
      ja: '💡 **招待リンク追跡**: 未付与（使う場合は BOT に「**サーバーの管理**」「**チャンネルの管理**」が必要）',
      en: '💡 **Invite tracking**: Optional (grant **Manage Server** & **Manage Channels** to track join invites)'
    })
  const eventCheck = hasManageEvents
    ? pick(interaction, { ja: '✅ **イベント作成・配信自動登録**: 有効', en: '✅ **Scheduled events & stream auto-events**: Ready' })
    : pick(interaction, {
      ja: '💡 **イベント作成・配信自動登録**: 未付与（使う場合は BOT に「**イベントの管理**」が必要）',
      en: '💡 **Scheduled events & stream auto-events**: Optional (grant **Manage Events** to use)'
    })
  return [channelCheck, inviteCheck, eventCheck].join('\n')
}

function creatorMenuRow (interaction, customId) {
  return {
    type: Eris.Constants.ComponentTypes.ACTION_ROW,
    components: [{
      type: Eris.Constants.ComponentTypes.SELECT_MENU,
      custom_id: customId,
      placeholder: pick(interaction, {
        ja: '🔧 開発者設定を切り替え（ベクトル化・セーフティ・デバッグ表示）',
        en: '🔧 Developer settings (embeddings, safety, debug footer)'
      }),
      min_values: 1,
      max_values: 1,
      options: [
        {
          label: pick(interaction, { ja: 'ベクトル化: オン（メッセージ＋絵文字）', en: 'Embeddings: On (messages & emojis)' }),
          description: pick(interaction, { ja: 'このサーバーでメッセージと絵文字のベクトル化を有効にする', en: 'Enable message and emoji embeddings here' }),
          value: 'embed:on'
        },
        {
          label: pick(interaction, { ja: 'ベクトル化: オフ（メッセージ＋絵文字）', en: 'Embeddings: Off (messages & emojis)' }),
          description: pick(interaction, { ja: 'このサーバーでメッセージと絵文字のベクトル化を停止する', en: 'Disable message and emoji embeddings here' }),
          value: 'embed:off'
        },
        {
          label: pick(interaction, { ja: 'ベクトル化: 既定に戻す', en: 'Embeddings: Reset to default' }),
          description: pick(interaction, { ja: 'オーナーサーバーはオン、それ以外はオフの既定に戻す', en: 'On for owner servers, off otherwise' }),
          value: 'embed:default'
        },
        {
          label: pick(interaction, { ja: 'セーフティ: 厳格（フィルタON・R18引き継ぎOFF）', en: 'Safety: Strict (filter ON, R18 OFF)' }),
          description: pick(interaction, { ja: 'Geminiセーフティフィルタを有効にし、R18引き継ぎを無効にする', en: 'Enable Gemini safety filter and disable uncensored handover' }),
          value: 'safety:strict'
        },
        {
          label: pick(interaction, { ja: 'セーフティ: 緩和（フィルタOFF・R18引き継ぎON）', en: 'Safety: Relaxed (filter OFF, R18 ON)' }),
          description: pick(interaction, { ja: 'セーフティフィルタをオフにし、R18モデル引き継ぎを有効にする', en: 'Disable Gemini safety filter and enable uncensored handover' }),
          value: 'safety:relaxed'
        },
        {
          label: pick(interaction, { ja: 'セーフティ: 既定に戻す', en: 'Safety: Reset to default' }),
          description: pick(interaction, { ja: 'オーナーサーバーは緩和、それ以外は厳格の既定に戻す', en: 'Relaxed for owner servers, strict otherwise' }),
          value: 'safety:default'
        },
        {
          label: pick(interaction, { ja: 'デバッグフッター: オン', en: 'Debug footer: On' }),
          description: pick(interaction, { ja: '返信の末尾にモデル名とトークン使用量を表示する', en: 'Show model and token usage under replies' }),
          value: 'debug:on'
        },
        {
          label: pick(interaction, { ja: 'デバッグフッター: オフ', en: 'Debug footer: Off' }),
          description: pick(interaction, { ja: '返信末尾のデバッグ表示を非表示にする', en: 'Hide model and token usage footer' }),
          value: 'debug:off'
        }
      ]
    }]
  }
}

async function applyCreatorChoice (interaction, guildID, choice) {
  const guild = global.bot.guilds?.get?.(guildID)
  if (choice === 'embed:on' || choice === 'embed:off' || choice === 'embed:default') {
    const val = choice === 'embed:default' ? null : choice === 'embed:on'
    await replySettings.setEmbedding(guildID, 'all', val)
    if (val === true || (val === null && isOwnerGuild(guildID))) {
      if (guild) emojiDescriber.schedule(guild)
    }
    return pick(interaction, { ja: '✅ ベクトル化（Embedding）設定を更新しました。', en: '✅ Updated embedding settings.' })
  }
  if (choice === 'safety:strict' || choice === 'safety:relaxed' || choice === 'safety:default') {
    const val = choice === 'safety:default' ? null : choice === 'safety:strict'
    await replySettings.setSafety(guildID, 'all', val)
    return pick(interaction, { ja: '✅ セーフティ・R18設定を更新しました。', en: '✅ Updated safety & R18 settings.' })
  }
  if (choice === 'debug:on' || choice === 'debug:off') {
    await replySettings.setDebugFooter(guildID, choice === 'debug:on')
    return pick(interaction, { ja: '✅ デバッグフッター設定を更新しました。', en: '✅ Updated debug footer setting.' })
  }
  return null
}

async function handleStatusSetup (interaction, { asEdit = false, initialNote = null } = {}) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const lang = langOf(interaction)
  if (!mayViewStatus(interaction)) {
    const msg = pick(interaction, {
      ja: '設定状況を確認・変更するには「サーバーの管理」「チャンネルの管理」「ウェブフックの管理」いずれかの権限が必要です。',
      en: 'Viewing or changing setup status requires Manage Server, Manage Channels, or Manage Webhooks.'
    })
    if (asEdit && typeof interaction.editOriginalMessage === 'function') {
      return interaction.editOriginalMessage({ content: msg, embeds: [], components: [] }).catch(() => {})
    }
    return interaction.createMessage({ content: msg, flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
  }

  let note = initialNote
  for (let first = true; ; first = false) {
    if (first && !asEdit && typeof interaction.defer === 'function') {
      await interaction.defer(Eris.Constants.MessageFlags.EPHEMERAL)
      asEdit = true
    }
    const guildID = interaction.guildID
    const guild = global.bot.guilds?.get?.(guildID)
    const guildSettings = await ensureGuildSettings(guildID)
    const groupedLogs = groupLogsByChannel(guildSettings, lang)
    const ignored = guildSettings?.ignoredChannels || []
    const logBots = Boolean(guildSettings?.isLogBots?.())
    const missingInChannel = (await returnMissingPerms(interaction.channel.id, global.bot.user.id)) || []
    const ai = await replySettings.getReplySettings(guildID).catch(() => ({}))
    const liveOn = process.env.YOUTUBE_API_KEY
      ? await youtubeDB.liveEventsOn(guildID).catch(() => false)
      : null
    let detectedRules = []
    if (guild?.channels?.size) {
      detectedRules = (await rulesChannels(guild).catch(() => [])).map(c => c.id)
    } else if (guild?.rulesChannelID) {
      detectedRules = [guild.rulesChannelID]
    }

    const personaText = ai.streamerPersona !== false
      ? pick(interaction, { ja: '配信者として話す', en: 'As the streamer' })
      : pick(interaction, { ja: 'BOT として話す', en: 'As the bot' })
    const lengthKey = ai.replyLength || DEFAULT_REPLY_LENGTH
    const lengthMap = {
      long: pick(interaction, { ja: '長め', en: 'Long' }),
      normal: pick(interaction, { ja: '内容に合わせる', en: 'Fitted' }),
      short: pick(interaction, { ja: '短め', en: 'Short' })
    }
    const aiLines = [
      pick(interaction, { ja: `・話し方: **${personaText}** ／ 返事の長さ: **${lengthMap[lengthKey] || lengthKey}**`, en: `・Persona: **${personaText}** / Length: **${lengthMap[lengthKey] || lengthKey}**` }),
      ...(liveOn !== null
        ? [pick(interaction, {
            ja: `・配信・新着動画の自動イベント登録: **${liveOn ? '有効' : '無効'}**`,
            en: `・Streams & uploads as events: **${liveOn ? 'On' : 'Off'}**`
          })]
        : []),
      ai.assistantRules
        ? pick(interaction, { ja: `・AI へのお願い（\`/assistantrules\`）: 設定あり（${[...ai.assistantRules].length} 文字）`, en: `・Moderator rules (\`/assistantrules\`): Set (${[...ai.assistantRules].length} chars)` })
        : pick(interaction, { ja: '・AI へのお願い（`/assistantrules`）: 未設定', en: '・Moderator rules (`/assistantrules`): None' }),
      detectedRules.length
        ? pick(interaction, { ja: `・サーバールール参照: ${detectedRules.map(id => `<#${id}>`).join('・')}`, en: `・Rules channel(s): ${detectedRules.map(id => `<#${id}>`).join(', ')}` })
        : pick(interaction, { ja: '・サーバールール参照: ルールチャンネル未検出', en: '・Rules channel(s): None detected' })
    ]

    const logSummary = groupedLogs.length
      ? groupedLogs.join('\n')
      : pick(interaction, {
        ja: '⚠️ **未設定** — 下の「ログ設定（まとめて）」ボタンから、このチャンネルへすぐ出力を開始できます。',
        en: '⚠️ **Not configured** — press "Log presets" below to start logging to this channel.'
      })
    const logExtras = pick(interaction, {
      ja: `対象外チャンネル: ${ignored.length ? ignored.map(id => `<#${id}>`).join('・') : 'なし'} ／ BOTの記録: ${logBots ? 'オン' : 'オフ'}`,
      en: `Ignored: ${ignored.length ? ignored.map(id => `<#${id}>`).join(', ') : 'None'} / Log bots: ${logBots ? 'On' : 'Off'}`
    })

    const creator = isCreator(interaction.member.user.id)
    const fields = [
      {
        name: pick(interaction, { ja: '📋 監査ログの設定状況', en: '📋 Audit Logging' }),
        value: `${clampStr(logSummary, 850)}\n${clampStr(logExtras, 170)}`
      },
      {
        name: pick(interaction, { ja: '🤖 AI（@メンション）の設定状況', en: '🤖 AI Assistant (@mention)' }),
        value: aiLines.join('\n')
      },
      {
        name: pick(interaction, { ja: '🔐 BOT 権限チェックリスト', en: '🔐 Bot Permissions Check' }),
        value: buildPermissionCheckField(interaction, missingInChannel)
      }
    ]

    if (creator) {
      const onOff = v => v ? pick(interaction, { ja: 'オン', en: 'On' }) : pick(interaction, { ja: 'オフ', en: 'Off' })
      fields.push({
        name: pick(interaction, { ja: '🔧 開発者設定（このサーバー）', en: '🔧 Developer Settings (this server)' }),
        value: pick(interaction, {
          ja: [
            `・ベクトル化: メッセージ **${onOff(ai.embedMessages)}** ／ 絵文字 **${onOff(ai.embedEmojis)}**`,
            `・セーフティ: フィルタ **${onOff(ai.safetyFilter)}** ／ R18引き継ぎ **${onOff(ai.uncensoredR18)}**`,
            `・デバッグフッター: **${onOff(ai.debugFooter)}**（モデル変更は \`${process.env.GLOBAL_BOT_PREFIX || '%'}replymodel\`、上限変更は \`${process.env.GLOBAL_BOT_PREFIX || '%'}tokenlimit\`）`
          ].join('\n'),
          en: [
            `・Embeddings: messages **${onOff(ai.embedMessages)}** / emojis **${onOff(ai.embedEmojis)}**`,
            `・Safety: filter **${onOff(ai.safetyFilter)}** / R18 handover **${onOff(ai.uncensoredR18)}**`,
            `・Debug footer: **${onOff(ai.debugFooter)}**`
          ].join('\n')
        })
      })
    }

    const id = uuidv4()
    const canEditLogs = mayCheckOrChangeLogs(interaction) && missingInChannel.length === 0
    const logsHereCount = activeCountHere(guildSettings?.getEventLogRaw?.() || {}, interaction.channel.id)
    const buttonComponents = [
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.PRIMARY,
        custom_id: `${id}:preset`,
        disabled: !canEditLogs,
        label: pick(interaction, { ja: 'ログ設定（まとめて）', en: 'Log presets' })
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.SECONDARY,
        custom_id: `${id}:individual`,
        disabled: !canEditLogs,
        label: pick(interaction, { ja: 'ログ設定（個別）', en: 'Individual events' })
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.SECONDARY,
        custom_id: `${id}:assistant`,
        label: pick(interaction, { ja: 'AI（メンション）設定', en: 'AI settings' })
      },
      ...(logsHereCount > 0 && mayCheckOrChangeLogs(interaction)
        ? [{
            type: Eris.Constants.ComponentTypes.BUTTON,
            style: Eris.Constants.ButtonStyles.DANGER,
            custom_id: `${id}:stophere`,
            label: pick(interaction, { ja: 'このチャンネルのログを停止', en: 'Stop logging here' })
          }]
        : [])
    ]

    const components = [
      ...(creator ? [creatorMenuRow(interaction, `${id}:dev`)] : []),
      {
        type: Eris.Constants.ComponentTypes.ACTION_ROW,
        components: buttonComponents
      }
    ]

    const baseDesc = pick(interaction, {
      ja: 'このサーバーの現在の設定と必要な権限の診断です。下のボタンからそのまま各設定画面へ移動できます。',
      en: 'Current settings and permission check for this server. Use the buttons below to configure logging or the AI assistant.'
    })
    const statusEmbed = clampEmbed({
      title: pick(interaction, { ja: '🛠️ ロボポリス 設定ステータス・初期設定ガイド', en: '🛠️ RoboPolice Setup Status & Guide' }),
      description: note ? `${note}\n\n${baseDesc}` : baseDesc,
      color: note?.startsWith('✅') ? EMBED_COLORS.GREEN : EMBED_COLORS.PURPLED_BLUE,
      fields,
      author: getAuthorField(interaction.member.user),
      footer: getEmbedFooter(global.bot.user)
    })

    try {
      if (first && !asEdit) {
        await interaction.createMessage({ embeds: [statusEmbed], components, flags: Eris.Constants.MessageFlags.EPHEMERAL })
      } else {
        await interaction.editOriginalMessage({ content: '', embeds: [statusEmbed], components, flags: Eris.Constants.MessageFlags.EPHEMERAL })
      }
    } catch (e) {
      global.logger.error('Error showing setup status', e)
      return
    }

    const watchedIds = [
      `${id}:preset`,
      `${id}:individual`,
      `${id}:assistant`,
      ...(logsHereCount > 0 && mayCheckOrChangeLogs(interaction) ? [`${id}:stophere`] : []),
      ...(creator ? [`${id}:dev`] : [])
    ]
    let clicked
    try {
      clicked = await Promise.any(watchedIds.map(cid =>
        awaitCustomID(cid, interaction.member.user.id, MENU_TIMEOUT_MS).then(res => ({ cid, res }))
      ))
    } catch (_) {
      return
    } finally {
      for (const cid of watchedIds) cancelCustomID(cid)
    }

    if (clicked.cid === `${id}:preset`) return handlePresetSetup(interaction, { asEdit: true })
    if (clicked.cid === `${id}:individual`) return handleIndividualSetup(interaction, { asEdit: true })
    if (clicked.cid === `${id}:assistant`) return handleAssistantSetup(interaction, { asEdit: true })
    if (clicked.cid === `${id}:stophere`) {
      try {
        await update.clearEventByID(guildID, interaction.channel.id)
        note = pick(interaction, {
          ja: `✅ <#${interaction.channel.id}> へのログ出力をすべて解除しました。`,
          en: `✅ Stopped logging all events to <#${interaction.channel.id}>.`
        })
      } catch (e) {
        global.logger.error('Error stopping logging from status menu', e)
        note = pick(interaction, { ja: '❌ ログ出力の解除に失敗しました。', en: '❌ Could not stop logging.' })
      }
      continue
    }
    if (clicked.cid === `${id}:dev`) {
      const selected = clicked.res?.data?.values?.[0]
      try {
        note = await applyCreatorChoice(interaction, guildID, selected)
      } catch (e) {
        global.logger.error('Error updating developer setting from status menu', e)
        note = pick(interaction, { ja: '❌ 設定の更新に失敗しました。', en: '❌ Could not update setting.' })
      }
    }
  }
}

module.exports = {
  name: 'setup',
  userPerms: ['manageWebhooks', 'manageChannels', 'viewAuditLog'],
  botPerms: ['manageWebhooks', 'viewAuditLog'],
  subcommandPerms: {
    assistant: { userPerms: [], botPerms: [] },
    status: { userPerms: [], botPerms: [] },
    list: { userPerms: ['manageWebhooks', 'manageChannels', 'viewAuditLog'], botPerms: [] }
  },
  noThread: true,
  func: async interaction => {
    if (interaction.data.options?.find(o => o.name === 'status')) {
      await handleStatusSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'via_presets')) {
      await handlePresetSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'via_individual_event')) {
      await handleIndividualSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'list')) {
      await handleListLogSetup(interaction)
    } else if (interaction.data.options?.find(o => o.name === 'assistant')) {
      await handleAssistantSetup(interaction)
    } else {
      await handleStatusSetup(interaction)
    }
  }
}
