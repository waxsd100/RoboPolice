const Eris = require('eris')
const { EMBED_COLORS, ALL_EVENTS, EVENT_HELP, EVENT_HELP_EN, LEGAL_LINKS, SUPPORT_SERVER_URL } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { retentionWindowClause } = require('../utils/retention')
const { langOf } = require('../utils/i18n')

// The general help, the setup guide and each event's, in Japanese or English.
const TEXT = {
  ja: {
    title: 'ヘルプ',
    intro: name => `**${name} の設定方法**\n簡単なセットアップ手順は \`/help guide: 使い方\` をご覧ください。`,
    source: ['ソースコード', '最新のコードは https://github.com/waxsd100/RoboPolice で公開しています。'],
    privacy: ['プライバシーポリシー', `[プライバシーポリシー](${LEGAL_LINKS.PRIVACY_POLICY}) | [利用規約](${LEGAL_LINKS.TERMS_OF_SERVICE})\nデータについてのご質問は[サポートサーバー](${SUPPORT_SERVER_URL})へどうぞ。`],
    support: ['サポート', `各イベントで記録される内容は \`/help event:\` で確認できます。うまく動かない場合は[サポートサーバー](${SUPPORT_SERVER_URL})へお越しください。`],
    guideTitle: '使い方ガイド',
    guide: name => `**__${name} の仕組み__**\nDiscord 上のほとんどの操作（BAN、メッセージ編集、メンバー参加など）を、\`ウェブフックの管理\` 権限があるチャンネルへ、イベントごと、またはまとめて出力できます。\n\n**__ログの設定方法__**\n出力先にしたいテキストチャンネルで \`/setup\` を実行し、\`via_presets\`（参加・メッセージなどをまとめて設定）か \`via_individual_event\`（イベントごとに設定）を選びます。必要なものを選んで選択メニューを閉じると、記録が始まります。各イベントの内容は \`/help event:\` で確認できます。\n\n*うまく動かない場合は* 下の要件をご確認ください。それでも解決しない場合は[サポートサーバー](${SUPPORT_SERVER_URL})までご連絡ください。`,
    joinPerms: ['__必要な権限: 参加ログ__', '参加したメンバーが使った招待を記録するには、**`チャンネルの管理`（チャンネル単位の権限の上書きでも可）と `サーバーの管理`** が必要です。これらが無いと Discord が招待の情報を BOT に送らないためです（チャンネルの管理: 作られた招待をその場で受け取る / サーバーの管理: サーバーの招待一覧を取得する）。\n\nこれらの権限を含む招待リンクは `/invite` で表示できます。'],
    messageScope: ['__記録できる範囲: メッセージログ__', name => `${name} は、送信されたときに見ていないメッセージの内容を、削除時に表示できません。BOT の参加前や停止中に送られたメッセージは、削除されても内容は表示されません。`],
    eventTitle: event => `${event} イベントで記録される内容`,
    eventBody: text => `__**説明**__\n${text}\n\n*お探しの内容と違う場合は[サポートサーバー](${SUPPORT_SERVER_URL})へお越しください。*`,
    events: EVENT_HELP
  },
  en: {
    title: 'Help',
    intro: name => `**Setting ${name} up**\nSee \`/help guide: Usage\` for the steps.`,
    source: ['Source code', 'The latest code is at https://github.com/waxsd100/RoboPolice.'],
    privacy: ['Privacy', `[Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) | [Terms of Service](${LEGAL_LINKS.TERMS_OF_SERVICE})\nQuestions about your data? Join the [support server](${SUPPORT_SERVER_URL}).`],
    support: ['Support', `See what each event records with \`/help event:\`. If something does not work, come to the [support server](${SUPPORT_SERVER_URL}).`],
    guideTitle: 'Usage guide',
    guide: name => `**__How ${name} works__**\nMost of what happens on Discord (bans, message edits, members joining…) can be logged, event by event or in groups, to channels where the bot has \`Manage Webhooks\`.\n\n**__Setting up logging__**\nRun \`/setup\` in the text channel to log to, and choose \`via_presets\` (groups such as joins and messages) or \`via_individual_event\` (one event at a time). Pick what you need and close the menu: logging starts. See what each event records with \`/help event:\`.\n\n*If it does not work,* check the requirements below. If that does not help, come to the [support server](${SUPPORT_SERVER_URL}).`,
    joinPerms: ['__Permissions needed: join log__', 'To log the invite a member joined with, the bot needs **`Manage Channels` (a channel permission overwrite will do) and `Manage Server`**: without them Discord does not send it invites (Manage Channels: invites as they are made / Manage Server: the server\'s invites).\n\n`/invite` shows an invite link with these permissions.'],
    messageScope: ['__What message logs can show__', name => `${name} cannot show the content of a deleted message it did not see being sent: messages sent before it joined or while it was down show no content when deleted.`],
    eventTitle: event => `What ${event} records`,
    eventBody: text => `__**Description**__\n${text}\n\n*Not what you were looking for? Come to the [support server](${SUPPORT_SERVER_URL}).*`,
    events: EVENT_HELP_EN
  }
}

const field = ([name, value], inline) => ({ name, value, inline })

module.exports = {
  name: 'help',
  TEXT,
  func: async interaction => {
    const lang = langOf(interaction)
    const text = TEXT[lang]
    const name = global.bot.user.username
    const user = interaction.member.user
    const option = which => interaction.data.options?.find(o => o.name === which)
    let embed
    if (option('event')) {
      const eventName = option('event').value
      if (!ALL_EVENTS.includes(eventName)) return
      embed = {
        title: text.eventTitle(eventName),
        author: getAuthorField(user),
        description: text.eventBody(text.events[eventName] || EVENT_HELP[eventName])
      }
    } else if (option('guide')) {
      embed = {
        title: text.guideTitle,
        description: text.guide(name),
        fields: [
          field(text.joinPerms, true),
          field([text.messageScope[0], `${text.messageScope[1](name)}${retentionWindowClause(name, lang)}`], true)
        ],
        author: getAuthorField(user),
        thumbnail: { url: user.dynamicAvatarURL(null, 64) }
      }
    } else {
      embed = {
        title: text.title,
        description: text.intro(name),
        thumbnail: { url: user.dynamicAvatarURL(null, 64) },
        fields: [field(text.source, true), field(text.support, true), field(text.privacy, false)]
      }
    }
    interaction.createMessage({
      embeds: [{ color: EMBED_COLORS.PURPLED_BLUE, footer: getEmbedFooter(global.bot.user), ...embed }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    }).catch(() => {})
  }
}
