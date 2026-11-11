const Eris = require('eris')
const { v4: uuidv4 } = require('uuid')
const { EMBED_COLORS, ALL_EVENTS, EVENT_HELP, EVENT_HELP_EN, LEGAL_LINKS, SUPPORT_SERVER_URL } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { retentionWindowClause } = require('../utils/retention')
const { langOf } = require('../utils/i18n')

const MENU_TIMEOUT_MS = 5 * 60 * 1000

// The general help, the setup guide, the AI mention guide, and each event's, in Japanese or English.
const TEXT = {
  ja: {
    title: 'ヘルプ',
    intro: name => [
      `**${name}** は監査ログの記録と \`@メンション\` による AI アシスタントを備えた BOT です。`,
      '',
      '・**初期設定・現在の状態を確認する**: `/setup status`',
      '・**ログ設定の手順を見る**: 下のボタン、または `/help guide: 使い方・初期設定`',
      '・**AIメンションの使い方を見る**: 下のボタン、または `/help guide: AIメンション・イベント・フォーラム`'
    ].join('\n'),
    quickCommands: [
      '主なコマンド',
      [
        '・`/setup status` — 設定状況・必要な権限の診断・クイック設定メニュー',
        '・`/setup via_presets` / `via_individual_event` — ログ出力の設定',
        '・`/setup assistant` — AI の話し方・返事の長さ・配信イベント登録',
        '・`/assistantrules` — AI に守ってほしい独自ルールの設定',
        '・`/invite` — 用途別の招待リンク（推奨権限つき）'
      ].join('\n')
    ],
    source: ['ソースコード', '最新のコードは https://github.com/waxsd100/RoboPolice で公開しています。'],
    privacy: ['プライバシーポリシー', `[プライバシーポリシー](${LEGAL_LINKS.PRIVACY_POLICY}) | [利用規約](${LEGAL_LINKS.TERMS_OF_SERVICE})\nデータについてのご質問は[サポートサーバー](${SUPPORT_SERVER_URL})へどうぞ。`],
    support: ['サポート', `各イベントで記録される内容は \`/help event:\` で確認できます。うまく動かない場合は[サポートサーバー](${SUPPORT_SERVER_URL})へお越しください。`],
    guideTitle: '使い方ガイド',
    guide: name => `**__${name} の初期設定と仕組み__**\nBOT をサーバーに招待すると（\`チャンネルの管理\` と \`ウェブフックの管理\` がある場合）、スタッフ専用チャンネル \`#robopolice-logs\` が自動作成され、すぐに全イベントの記録が始まります。現在の設定や権限の過不足はいつでも **\`/setup status\`** で診断できます。\n\n**__ログ出力先の変更・カスタマイズ__**\n出力先にしたいテキストチャンネルで \`/setup via_presets\`（カテゴリごと）または \`/setup via_individual_event\`（イベントごと）を実行します。除外したいチャンネルは \`/ignorechannel\`、停止は \`/stoplogging\` で設定できます。各イベントの詳細は \`/help event:\` で確認できます。\n\n*うまく動かない場合は* 下の要件または \`/setup status\` をご確認ください。解決しない場合は[サポートサーバー](${SUPPORT_SERVER_URL})までご連絡ください。`,
    joinPerms: ['__必要な権限: 参加ログ__', '参加したメンバーが使った招待を記録するには、**`チャンネルの管理`（チャンネル単位の権限の上書きでも可）と `サーバーの管理`** が必要です。これらが無いと Discord が招待の情報を BOT に送らないためです。\n\n推奨権限を含む招待リンクは `/invite` で表示できます。'],
    messageScope: ['__記録できる範囲: メッセージログ__', name => `${name} は、送信されたときに見ていないメッセージの内容を、削除時に表示できません。BOT の参加前や停止中に送られたメッセージは、削除されても内容は表示されません。`],
    assistantTitle: 'AIメンション・イベント・フォーラムガイド',
    assistantGuide: name => [
      `**__@${name} に話しかける__**`,
      'テキストチャンネルで BOT に `@メンション` すると、会話や質問応答のほか、文章やURL・返信元メッセージから下書きを作成できます（作成ボタンを押すまで公開されません）。',
      '',
      '・**質問・雑談**: `@ロボポリス 最近の配信でおすすめは？`（BOT の返信にメンション付きで返信すると会話を継続）',
      '・**予定イベント作成**: `@ロボポリス 11/3 19時から交流会`（依頼者と BOT に `イベントの管理` 権限が必要）',
      '・**フォーラム投稿作成**: `@ロボポリス #募集 に交流会の募集を立てて`（カバー画像の切り抜き・AI生成・指示編集にも対応）',
      '・**作成後の修正**: BOT の完了メッセージやフォーラム投稿に返信して `@ロボポリス 開始を20時に`'
    ].join('\n'),
    assistantConfig: [
      '__サーバーごとの AI 設定（要: サーバーの管理）__',
      [
        '・`/setup assistant` — 話し方（配信者として／BOTとして）、返事の長さ、YouTube配信・新着動画の自動イベント登録をメニューで設定',
        '・`/assistantrules` — ネタバレ禁止など AI に守ってほしいお願いを設定（Discord のルールチャンネルも自動で参照します）',
        '・`/youtube show` / `/youtube summarize` — フォロー中の YouTube チャンネル確認・動画要約'
      ].join('\n')
    ],
    buttons: {
      overview: '概要',
      usage: '初期設定・ログの使い方',
      assistant: 'AIメンションの使い方',
      support: 'サポートサーバー'
    },
    eventTitle: event => `${event} イベントで記録される内容`,
    eventBody: text => `__**説明**__\n${text}\n\n*お探しの内容と違う場合は[サポートサーバー](${SUPPORT_SERVER_URL})へお越しください。*`,
    events: EVENT_HELP
  },
  en: {
    title: 'Help',
    intro: name => [
      `**${name}** provides audit logging and an \`@mention\` AI assistant.`,
      '',
      '・**Check setup status & permissions**: `/setup status`',
      '・**Logging setup guide**: press the button below or run `/help guide: Usage & Initial Setup`',
      '・**AI mention guide**: press the button below or run `/help guide: AI Mention, Events & Forums`'
    ].join('\n'),
    quickCommands: [
      'Key commands',
      [
        '・`/setup status` — Check current setup, diagnose permissions, and open setup menus',
        '・`/setup via_presets` / `via_individual_event` — Choose logged events',
        '・`/setup assistant` — Configure AI persona, reply length, and stream events',
        '・`/assistantrules` — Set custom rules for the AI assistant',
        '・`/invite` — Invite links with recommended permissions'
      ].join('\n')
    ],
    source: ['Source code', 'The latest code is at https://github.com/waxsd100/RoboPolice.'],
    privacy: ['Privacy', `[Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) | [Terms of Service](${LEGAL_LINKS.TERMS_OF_SERVICE})\nQuestions about your data? Join the [support server](${SUPPORT_SERVER_URL}).`],
    support: ['Support', `See what each event records with \`/help event:\`. If something does not work, come to the [support server](${SUPPORT_SERVER_URL}).`],
    guideTitle: 'Usage guide',
    guide: name => `**__How ${name} works__**\nWhen invited with \`Manage Channels\` and \`Manage Webhooks\`, the bot automatically creates a staff-only \`#robopolice-logs\` channel and starts logging every event. Run **\`/setup status\`** anytime to check active settings and permissions.\n\n**__Setting up logging__**\nRun \`/setup via_presets\` (groups such as joins and messages) or \`/setup via_individual_event\` (one event at a time) in the channel you want to log to. Exclude channels with \`/ignorechannel\` or stop with \`/stoplogging\`. See what each event records with \`/help event:\`.\n\n*If it does not work,* check the requirements below or \`/setup status\`. If that does not help, come to the [support server](${SUPPORT_SERVER_URL}).`,
    joinPerms: ['__Permissions needed: join log__', 'To log the invite a member joined with, the bot needs **`Manage Channels` (a channel permission overwrite will do) and `Manage Server`**: without them Discord does not send it invites.\n\n`/invite` shows invite links with these permissions.'],
    messageScope: ['__What message logs can show__', name => `${name} cannot show the content of a deleted message it did not see being sent: messages sent before it joined or while it was down show no content when deleted.`],
    assistantTitle: 'AI Mention, Events & Forums guide',
    assistantGuide: name => [
      `**__Mentioning @${name}__**`,
      'Mention the bot in any text channel to chat, ask questions, or draft scheduled events and forum posts from text, links, or replied-to messages (nothing is published until you confirm the preview).',
      '',
      '・**Chat & Q&A**: `@RoboPolice What streams do you recommend?` (reply to the bot with a mention to continue)',
      '・**Scheduled events**: `@RoboPolice Community meetup on Nov 3 at 19:00` (needs `Manage Events` for you and the bot)',
      '・**Forum posts**: `@RoboPolice Post a recruitment thread in #lfg` (supports cropping, AI cover generation, and image edits)',
      '・**Edit after posting**: reply to the bot\'s confirmation or forum post with `@RoboPolice move start to 20:00`'
    ].join('\n'),
    assistantConfig: [
      '__Per-server AI settings (needs Manage Server)__',
      [
        '・`/setup assistant` — Menu for persona (streamer / bot), reply length, and automatic stream/upload events',
        '・`/assistantrules` — Set moderator rules for the AI (server rules channels are also read automatically)',
        '・`/youtube show` / `/youtube summarize` — View followed YouTube channels and summarize videos'
      ].join('\n')
    ],
    buttons: {
      overview: 'Overview',
      usage: 'Initial Setup & Logging',
      assistant: 'AI Mention Guide',
      support: 'Support Server'
    },
    eventTitle: event => `What ${event} records`,
    eventBody: text => `__**Description**__\n${text}\n\n*Not what you were looking for? Come to the [support server](${SUPPORT_SERVER_URL}).*`,
    events: EVENT_HELP_EN
  }
}

const field = ([name, value], inline) => ({ name, value, inline })

function buildGuideEmbed (tab, { lang, text, name, user }) {
  const base = { color: EMBED_COLORS.PURPLED_BLUE, footer: getEmbedFooter(global.bot.user) }
  if (tab === 'usage') {
    return {
      ...base,
      title: text.guideTitle,
      description: text.guide(name),
      fields: [
        field(text.joinPerms, true),
        field([text.messageScope[0], `${text.messageScope[1](name)}${retentionWindowClause(name, lang)}`], true)
      ],
      author: getAuthorField(user),
      thumbnail: { url: user.dynamicAvatarURL(null, 64) }
    }
  }
  if (tab === 'assistant') {
    return {
      ...base,
      title: text.assistantTitle,
      description: text.assistantGuide(name),
      fields: [field(text.assistantConfig, false)],
      author: getAuthorField(user),
      thumbnail: { url: user.dynamicAvatarURL(null, 64) }
    }
  }
  return {
    ...base,
    title: text.title,
    description: text.intro(name),
    thumbnail: { url: user.dynamicAvatarURL(null, 64) },
    fields: [
      field(text.quickCommands, false),
      field(text.source, true),
      field(text.support, true),
      field(text.privacy, false)
    ]
  }
}

function buildHelpComponents (text, id, activeTab) {
  return [{
    type: Eris.Constants.ComponentTypes.ACTION_ROW,
    components: [
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: activeTab === 'overview' ? Eris.Constants.ButtonStyles.PRIMARY : Eris.Constants.ButtonStyles.SECONDARY,
        disabled: activeTab === 'overview',
        custom_id: `${id}:overview`,
        label: text.buttons.overview
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: activeTab === 'usage' ? Eris.Constants.ButtonStyles.PRIMARY : Eris.Constants.ButtonStyles.SECONDARY,
        disabled: activeTab === 'usage',
        custom_id: `${id}:usage`,
        label: text.buttons.usage
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: activeTab === 'assistant' ? Eris.Constants.ButtonStyles.PRIMARY : Eris.Constants.ButtonStyles.SECONDARY,
        disabled: activeTab === 'assistant',
        custom_id: `${id}:assistant`,
        label: text.buttons.assistant
      },
      {
        type: Eris.Constants.ComponentTypes.BUTTON,
        style: Eris.Constants.ButtonStyles.LINK,
        url: SUPPORT_SERVER_URL,
        label: text.buttons.support
      }
    ]
  }]
}

async function watchHelpTabs (interaction, initialId, initialTab, ctx) {
  const { awaitCustomID, cancelCustomID } = require('../events/interactionCreate')
  let id = initialId
  let tab = initialTab
  for (;;) {
    const tabs = ['overview', 'usage', 'assistant'].filter(t => t !== tab)
    const ids = tabs.map(t => `${id}:${t}`)
    let nextTab
    try {
      nextTab = await Promise.any(tabs.map(t =>
        awaitCustomID(`${id}:${t}`, ctx.user.id, MENU_TIMEOUT_MS).then(() => t)
      ))
    } catch (_) {
      return
    } finally {
      for (const cid of ids) cancelCustomID(cid)
    }
    tab = nextTab
    id = uuidv4()
    try {
      await interaction.editOriginalMessage({
        embeds: [buildGuideEmbed(tab, ctx)],
        components: buildHelpComponents(ctx.text, id, tab),
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      })
    } catch (_) {
      return
    }
  }
}

module.exports = {
  name: 'help',
  TEXT,
  func: async interaction => {
    const lang = langOf(interaction)
    const text = TEXT[lang]
    const name = global.bot.user.username
    const user = interaction.member.user
    const option = which => interaction.data.options?.find(o => o.name === which)
    if (option('event')) {
      const eventName = option('event').value
      if (!ALL_EVENTS.includes(eventName)) return
      const embed = {
        color: EMBED_COLORS.PURPLED_BLUE,
        footer: getEmbedFooter(global.bot.user),
        title: text.eventTitle(eventName),
        author: getAuthorField(user),
        description: text.eventBody(text.events[eventName] || EVENT_HELP[eventName])
      }
      await interaction.createMessage({
        embeds: [embed],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
      return
    }

    const guideValue = option('guide')?.value
    const tab = guideValue === 'assistant' ? 'assistant' : guideValue ? 'usage' : 'overview'
    const ctx = { lang, text, name, user }
    const id = uuidv4()
    const interactive = typeof interaction.editOriginalMessage === 'function' && Boolean(user.id)
    await interaction.createMessage({
      embeds: [buildGuideEmbed(tab, ctx)],
      ...(interactive ? { components: buildHelpComponents(text, id, tab) } : {}),
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    }).catch(() => {})
    if (interactive) {
      watchHelpTabs(interaction, id, tab, ctx).catch(() => {})
    }
  }
}
