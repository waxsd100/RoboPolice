// /setup assistant: the mention assistant's settings for the server in one place, as select menus
// that show the current choice and save a new one at once: how it speaks (/persona), how long its
// replies are (/replylength) and, when the bot reads YouTube, whether streams and new uploads become
// server events (/youtube liveevents). Those commands stay; this is the same settings, together.
// Needs Manage Server, like the commands it gathers.
const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const replySettings = require('../../db/interfaces/postgres/replySettings')
const youtubeDB = require('../../db/interfaces/postgres/youtube')
const { DEFAULT_REPLY_LENGTH } = require('./eventDrafter')
const { EMBED_COLORS } = require('../utils/constants')
const { isCreator } = require('../utils/creatorIds')
const { hasStaffAccess } = require('../utils/staffAccess')
const { langOf } = require('../utils/i18n')

const TEXT = {
  ja: {
    title: 'AI（メンション）の設定',
    description: 'BOT にメンションしたときの返事の設定です。下のメニューで選ぶと、すぐ保存されて次のメンションから反映されます。',
    persona: { placeholder: '話し方', streamer: ['配信者として話す', 'チャンネルの配信者本人になりきって話す（初期値）'], bot: ['BOT として話す', '配信者にはなりきらず、サーバーの BOT として話す'] },
    length: { placeholder: '返事の長さ', long: ['長め', '長くても500文字程度（初期値）'], normal: ['内容に合わせる', 'あいさつは短く、説明は長めに'], short: ['短め', '答えだけ。長くても200文字程度'] },
    live: { placeholder: '配信・新着動画のイベント登録', on: ['イベントに登録する', '配信と新着動画をサーバーのイベントに自動で登録する'], off: ['登録しない', '配信と新着動画をイベントにしない（初期値）'] },
    fields: { persona: '話し方', length: '返事の長さ', live: '配信・新着動画のイベント登録' },
    saved: '保存しました。',
    noManageEvents: 'BOT に「イベントの管理」権限がないため、配信をイベントに登録できません。権限を付けてからもう一度選んでください。',
    noPermission: 'この設定を変えるには「サーバーの管理」権限が必要です。',
    failed: '設定を保存できませんでした。もう一度お試しください。'
  },
  en: {
    title: 'Assistant (mention) settings',
    description: 'How the bot replies when mentioned. A choice below is saved at once and applies from the next mention.',
    persona: { placeholder: 'How it speaks', streamer: ['As the streamer', 'Speaks as the channel\'s streamer (default)'], bot: ['As the bot', 'Speaks as the server\'s bot, not as the streamer'] },
    length: { placeholder: 'Reply length', long: ['Long', 'Up to about 500 characters (default)'], normal: ['Fitted to the talk', 'Short greetings, longer explanations'], short: ['Short', 'Just the answer, up to about 200 characters'] },
    live: { placeholder: 'Streams and uploads as events', on: ['Make them events', 'Streams and new uploads become server events automatically'], off: ['Do not', 'Streams and new uploads are not made events (default)'] },
    fields: { persona: 'How it speaks', length: 'Reply length', live: 'Streams and uploads as events' },
    saved: 'Saved.',
    noManageEvents: 'The bot does not have Manage Events, so it cannot make events for streams. Give it the permission and choose again.',
    noPermission: 'Changing these settings needs Manage Server.',
    failed: 'Could not save the setting. Please try again.'
  }
}

const youtubeOn = () => !!process.env.YOUTUBE_API_KEY

function mayChange (interaction) {
  const member = interaction.member
  if (isCreator(member.user.id)) return true
  const guild = global.bot.guilds.get(interaction.guildID)
  if (hasStaffAccess(member.roles, guild)) return true
  return !!interaction.channel.permissionsOf(member.user.id)?.json?.manageGuild
}

async function current (guildID) {
  const { replyLength, streamerPersona } = await replySettings.getReplySettings(guildID)
  return {
    persona: streamerPersona !== false ? 'streamer' : 'bot',
    length: replyLength || DEFAULT_REPLY_LENGTH,
    live: youtubeOn() && await youtubeDB.liveEventsOn(guildID) ? 'on' : 'off'
  }
}

// The menus, each showing the current choice. ids: { persona, length, live }.
function menus (text, settings, ids) {
  const menu = (which, values) => ({
    type: Eris.Constants.ComponentTypes.ACTION_ROW,
    components: [{
      type: Eris.Constants.ComponentTypes.SELECT_MENU,
      custom_id: ids[which],
      placeholder: text[which].placeholder,
      min_values: 1,
      max_values: 1,
      options: values.map(value => ({ label: text[which][value][0], description: text[which][value][1], value, default: settings[which] === value }))
    }]
  })
  return [
    menu('persona', ['streamer', 'bot']),
    menu('length', ['long', 'normal', 'short']),
    ...(youtubeOn() ? [menu('live', ['on', 'off'])] : [])
  ]
}

function embed (text, settings, note) {
  const label = which => text[which][settings[which]][0]
  return {
    title: text.title,
    description: note ? `${text.description}\n\n${note}` : text.description,
    color: EMBED_COLORS.PURPLED_BLUE,
    fields: [
      { name: text.fields.persona, value: label('persona'), inline: true },
      { name: text.fields.length, value: label('length'), inline: true },
      ...(youtubeOn() ? [{ name: text.fields.live, value: label('live'), inline: true }] : [])
    ]
  }
}

// Saves one choice. Resolves to a note for the message.
async function save (interaction, text, which, value) {
  const guildID = interaction.guildID
  if (which === 'persona') await replySettings.setStreamerPersona(guildID, value === 'streamer')
  if (which === 'length') await replySettings.setReplyLength(guildID, value)
  if (which === 'live') {
    const guild = global.bot.guilds.get(guildID)
    if (value === 'on' && !guild?.members.get(global.bot.user.id)?.permissions.has('manageEvents')) return text.noManageEvents
    await youtubeDB.setLiveEvents(guildID, value === 'on')
  }
  return text.saved
}

// Shows the settings and saves what is chosen, until nothing is chosen for a minute.
async function handleAssistantSetup (interaction) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  const text = TEXT[langOf(interaction)]
  if (!mayChange(interaction)) {
    return interaction.createMessage({ content: text.noPermission, flags: Eris.Constants.MessageFlags.EPHEMERAL }).catch(() => {})
  }
  let note = null
  for (let first = true; ; first = false) {
    const settings = await current(interaction.guildID)
    const id = uuidv4()
    const ids = { persona: `${id}:persona`, length: `${id}:length`, live: `${id}:live` }
    const message = { embeds: [embed(text, settings, note)], components: menus(text, settings, ids), flags: Eris.Constants.MessageFlags.EPHEMERAL }
    try {
      if (first) await interaction.createMessage(message)
      else await interaction.editOriginalMessage(message)
    } catch (e) {
      global.logger.error('Error showing the assistant settings', e)
      return
    }
    const waiting = Object.entries(ids).map(([which, customID]) => awaitCustomID(customID, interaction.member.user.id).then(chosen => ({ which, chosen })))
    let answer
    try {
      answer = await Promise.any(waiting)
    } catch (_) {
      return // nothing chosen in time
    } finally {
      for (const customID of Object.values(ids)) cancelCustomID(customID)
    }
    const value = answer.chosen.data.values?.[0]
    if (!value) continue
    try {
      note = await save(interaction, text, answer.which, value)
    } catch (e) {
      global.logger.error('Error saving an assistant setting', e)
      note = text.failed
    }
  }
}

module.exports = { handleAssistantSetup, TEXT }
