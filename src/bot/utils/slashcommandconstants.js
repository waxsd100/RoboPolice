// The slash commands, as registered with Discord (/setcmds). Each description and choice is in
// English, with a Japanese translation that Discord shows to Japanese clients
// (description_localizations, name_localizations); the replies follow the client's language too
// (utils/i18n.js).
const ERIS_CONSTANTS = require('eris').Constants
const { STRING, INTEGER, BOOLEAN, CHANNEL, SUB_COMMAND } = ERIS_CONSTANTS.ApplicationCommandOptionTypes

// A description in English and Japanese.
const describe = (en, ja) => ({ description: en, description_localizations: { ja } })
// A choice, named in English and Japanese.
const choice = (value, en, ja) => ({ name: en, name_localizations: { ja }, value })

// The events /help explains (Discord takes at most 25 choices).
const HELP_EVENTS = [
  ['channelCreate', 'Channel Create', 'チャンネル作成'],
  ['channelUpdate', 'Channel Update', 'チャンネル更新'],
  ['channelDelete', 'Channel Delete', 'チャンネル削除'],
  ['guildBanAdd', 'Member Banned', 'メンバーBAN'],
  ['guildBanRemove', 'Member Unbanned', 'メンバーBAN解除'],
  ['guildRoleCreate', 'Role Create', 'ロール作成'],
  ['guildRoleDelete', 'Role Delete', 'ロール削除'],
  ['guildRoleUpdate', 'Role Update', 'ロール更新'],
  ['guildUpdate', 'Server Settings Change', 'サーバー設定変更'],
  ['guildEmojisUpdate', 'Server Emojis Change', 'サーバー絵文字変更'],
  ['messageDelete', 'Message Delete', 'メッセージ削除'],
  ['messageDeleteBulk', 'Bulk Message Delete', 'メッセージ一括削除'],
  ['messageUpdate', 'Message Edit', 'メッセージ編集'],
  ['guildMemberAdd', 'Member Join', 'メンバー参加'],
  ['guildMemberKick', 'Member Kick', 'メンバーキック'],
  ['guildMemberRemove', 'Member Leave', 'メンバー退出'],
  ['guildMemberNickUpdate', 'Member Nickname Update', 'ニックネーム変更'],
  ['guildMemberUpdate', 'Member Role Add/Remove', 'ロール付与・剥奪'],
  ['guildMemberVerify', 'Member Gate Verify', 'メンバー認証通過'],
  ['voiceChannelLeave', 'Voice Channel Leave', 'ボイス退出'],
  ['voiceChannelJoin', 'Voice Channel Join', 'ボイス参加'],
  ['voiceChannelSwitch', 'Voice Channel Moved', 'ボイス移動'],
  ['voiceStateUpdate', 'Member Voice Muted/Deafened', 'ボイスミュート'],
  ['presenceUpdate', 'Custom Status Update', 'カスタムステータス変更']
]

exports.commands = [
  {
    name: 'help',
    ...describe('How to use the bot: initial setup, AI mention features, and what each log event records', 'BOT の使い方（初期設定、AIメンション機能、各ログイベントの内容）'),
    options: [
      {
        type: STRING,
        name: 'event',
        ...describe('What a log event records', 'ログイベントで記録される内容'),
        choices: HELP_EVENTS.map(([value, en, ja]) => choice(value, en, ja))
      },
      {
        type: STRING,
        name: 'guide',
        ...describe('Guides for setting up logging and using AI mentions', '初期設定・ログ設定やAIメンションの使い方ガイド'),
        choices: [
          choice('usage', 'Usage & Initial Setup', '使い方・初期設定'),
          choice('assistant', 'AI Mention, Events & Forums', 'AIメンション・イベント・フォーラム')
        ]
      }
    ]
  },
  {
    name: 'setup',
    ...describe('Set the bot up: check status, choose log events, and configure the AI assistant', 'BOT の初期設定・確認（ステータス診断、記録するログ、AI の返事の設定）'),
    options: [
      {
        type: SUB_COMMAND,
        name: 'status',
        ...describe('Check current setup status, required permissions, and quick setup menus', '初期設定の状況・必要な権限の診断と、ログ・AI設定メニューを表示する')
      },
      {
        type: SUB_COMMAND,
        name: 'via_presets',
        ...describe('Choose events in groups (members joining, messages, roles, channels…)', 'イベントをまとめて選ぶ（参加・メッセージ・ロール・チャンネルなど）')
      },
      {
        type: SUB_COMMAND,
        name: 'via_individual_event',
        ...describe('Choose events one by one', 'イベントを1つずつ選ぶ')
      },
      {
        type: SUB_COMMAND,
        name: 'list',
        ...describe('List the channels each event is logged to (/stoplogging to stop)', 'イベントごとの出力先チャンネルを表示する（止めるには /stoplogging）')
      },
      {
        type: SUB_COMMAND,
        name: 'assistant',
        ...describe('How the assistant replies: as the streamer or the bot, reply length, streams as events', 'AI の返事の設定（話し方、返事の長さ、配信・新着動画のイベント登録）')
      }
    ]
  },
  {
    name: 'stoplogging',
    ...describe('Stop logging to a channel (or everywhere)', 'チャンネルへのログ出力を止める（またはすべて止める）'),
    options: [
      {
        type: CHANNEL,
        name: 'channel',
        ...describe('The channel to stop logging to (this one if left out)', '出力を止めるチャンネル（省略するとこのチャンネル）'),
        channel_types: [0, 2, 4] // text, voice, category
      },
      {
        type: STRING,
        name: 'other',
        ...describe('Stop logging everywhere', 'すべての出力を止める'),
        choices: [choice('everything', 'Stop logging everything, everywhere', 'すべてのチャンネルへの出力を止める')]
      }
    ]
  },
  {
    name: 'ignorechannel',
    ...describe('Leave a channel out of the logs, or bring it back', 'チャンネルをログの対象から外す（もう一度で戻す）'),
    options: [
      {
        type: CHANNEL,
        name: 'channel-to-ignore',
        ...describe('The channel (this one if left out)', '対象のチャンネル（省略するとこのチャンネル）'),
        channel_types: [0, 2, 4] // text, voice, category
      },
      {
        type: STRING,
        name: 'optional',
        ...describe('List or reset the channels left out', '対象外のチャンネルを表示・リセットする'),
        choices: [
          choice('list', 'List the channels left out', '対象外のチャンネルを表示'),
          choice('reset', 'Bring every channel back', 'すべてのチャンネルを対象に戻す')
        ]
      }
    ]
  },
  {
    name: 'logbots',
    ...describe('Whether edits and deletions of other bots\' messages are logged (default: no)', '他の BOT のメッセージの編集・削除もログに出すかを切り替える（初期値: 出さない）')
  },
  {
    name: 'persona',
    ...describe('Whether the assistant speaks as the streamer here (shows the setting if left out)', 'AI が配信者として話すかを切り替える（省略すると今の設定を表示）'),
    options: [{
      type: BOOLEAN,
      name: 'streamer',
      ...describe('True: as the streamer (default), False: as the server\'s bot', 'True: 配信者として（初期値）、False: サーバーの BOT として'),
      required: false
    }]
  },
  {
    name: 'replylength',
    ...describe('How long the assistant\'s replies are here (shows the setting if left out)', 'AI の返事の長さを変える（省略すると今の設定を表示）'),
    options: [{
      type: STRING,
      name: 'length',
      ...describe('long: up to about 500 characters (default), normal: fitted to the talk, short: brief', 'long: 長め（500文字程度まで、初期値）、normal: 内容に合わせる、short: 短め'),
      required: false,
      choices: [
        choice('long', 'long (default, up to ~500 characters)', '長め（初期値、500文字程度まで）'),
        choice('normal', 'normal (fitted to what was said)', '内容に合わせる'),
        choice('short', 'short (brief)', '短め')
      ]
    }]
  },
  {
    name: 'assistantrules',
    ...describe('What the assistant keeps to here, besides the rules channel (shows it if left out)', 'AI に守ってほしいこと（ルールチャンネル以外に。省略すると今の内容を表示）'),
    options: [{
      type: STRING,
      name: 'text',
      ...describe('e.g. No spoilers for new games. No politics. (up to 2,000 characters)', '例: 新作ゲームのネタバレはしない。政治の話はしない。（2000文字まで）'),
      max_length: 2000,
      required: false
    }, {
      type: BOOLEAN,
      name: 'clear',
      ...describe('True to remove it', 'True で消す'),
      required: false
    }]
  },
  {
    name: 'youtube',
    ...describe('The YouTube channels the assistant knows about (shared by every server)', 'AI が知っている YouTube チャンネル（全サーバー共通）'),
    options: [
      {
        type: SUB_COMMAND,
        name: 'sync',
        ...describe('Read the channels again (latest videos and streams; from the owner\'s servers)', 'チャンネルを読み直す（最新の動画と配信。オーナーのサーバーからのみ）')
      },
      {
        type: SUB_COMMAND,
        name: 'summarize',
        ...describe('Summarize the newest videos (or the video at url)', '新しい動画（または url の動画）の内容を要約する'),
        options: [{
          type: INTEGER,
          name: 'count',
          ...describe('How many of the newest videos (1-50, default 3)', '新しい順に何本か（1〜50、初期値 3）'),
          min_value: 1,
          max_value: 50,
          required: false
        }, {
          type: BOOLEAN,
          name: 'force',
          ...describe('Summarize again even if already summarized', '要約済みでも要約し直す'),
          required: false
        }, {
          type: STRING,
          name: 'url',
          ...describe('Summarize this video instead (any public YouTube video link)', 'この動画を要約する（公開されている YouTube 動画のリンク）'),
          required: false
        }]
      },
      {
        type: SUB_COMMAND,
        name: 'liveevents',
        ...describe('Register streams and new uploads as server events automatically', '配信と新着動画をサーバーのイベントに自動で登録する'),
        options: [{
          type: BOOLEAN,
          name: 'enabled',
          ...describe('True to turn it on, False to turn it off', 'True でオン、False でオフ'),
          required: true
        }]
      },
      {
        type: SUB_COMMAND,
        name: 'show',
        ...describe('Show what is stored', '保存している内容を表示する')
      }
    ]
  },
  {
    name: 'invite',
    ...describe('Links to invite the bot, by what it is for', '用途別の BOT の招待リンク')
  },
  {
    name: 'clearmydata',
    ...describe('How to have your stored data deleted', '保存されている自分のデータを削除してもらう方法')
  }
]

exports.developerCommands = [{
  name: 'setcmds',
  description: '[OWNER ONLY] register the slash commands',
  options: [{
    type: STRING,
    name: 'scope',
    description: '[OWNER ONLY] where to register them',
    choices: [{
      name: 'Guild',
      value: 'guild'
    }, {
      name: 'Global',
      value: 'global'
    }]
  }]
}, {
  name: 'reloadinteractions',
  description: '[OWNER ONLY] reload interaction handling logic'
}]
