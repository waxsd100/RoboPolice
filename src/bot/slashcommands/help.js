const Eris = require('eris')
const { EMBED_COLORS, ALL_EVENTS, EVENT_HELP, LEGAL_LINKS } = require('../utils/constants')
const { getEmbedFooter, getAuthorField } = require('../utils/embeds')
const { retentionWindowClause } = require('../utils/retention')

module.exports = {
  name: 'help',
  func: async interaction => {
    if (!interaction.data.options) {
      // general help
      interaction.createMessage({
        embeds: [{
          title: 'ヘルプ',
          description: `**${global.bot.user.username} の設定方法**\n簡単なセットアップ手順は \`/help guide: Usage\` をご覧ください。`,
          color: EMBED_COLORS.PURPLED_BLUE,
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          },
          fields: [{
            inline: true,
            name: 'ソースコード',
            value: '最新のコードは https://github.com/waxsd100/RoboPolice で公開しています。'
          }, {
            inline: true,
            name: 'ダッシュボード',
            value: 'ホスティング先のWebサイトが無いため、ダッシュボードの提供予定はありません。'
          }, {
            inline: false,
            name: 'プライバシーポリシー',
            value: `[Privacy Policy](${LEGAL_LINKS.PRIVACY_POLICY}) | [Terms of Service](${LEGAL_LINKS.TERMS_OF_SERVICE})\nQuestions about your data? Join the [support server](${process.env.DISCORD_SUPPORT_SERVER}).`
          }, {
            inline: true,
            name: 'サポート',
            value: `個々のイベントの詳細は \`/help event: eventname\` で確認できます。うまく動かない場合は[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER})へお越しください。`
          }, {
            inline: false,
            name: '支援について',
            value: `このBOTを気に入っていただけた場合は \`@${process.env.BOT_CREATOR_NAME}\` までご連絡ください。`
          }],
          footer: getEmbedFooter(global.bot.user)
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    } else if (interaction.data.options?.find(o => o.name === 'guide')) {
      interaction.createMessage({
        embeds: [{
          title: '使い方ガイド',
          color: EMBED_COLORS.PURPLED_BLUE,
          description: `**__${global.bot.user.username} の仕組み__**\nDiscord 上のほとんどの操作（BAN、メッセージ編集、メンバー参加など）は、\`ウェブフックの管理\` 権限があるチャンネルへ、個別またはプリセット単位で出力先を設定できます。\n\n**__ログの設定方法__**\n出力先にしたいテキストチャンネルで \`/setup\` を実行します。\`via_presets\`（joinlog、messages などをまとめて設定）または \`via_individual_event\`（イベントごとに個別設定）を選んでください。必要なプリセットやイベントを選び終えたら選択ボックスを閉じると、ログの記録が始まります。各イベントの詳細は \`/help event\` で確認できます。\n\n*うまく動かない場合は* 下記の要件をご確認ください。それでも解決しない場合は \`@${process.env.BOT_CREATOR_NAME}\` までご連絡ください。`,
          fields: [{
            inline: true,
            name: '__必要な権限: 参加ログ__',
            value: '参加したメンバーが使用した招待コードを記録するには、**`チャンネルの管理`（チャンネル単位の権限上書きでも可）と `サーバー管理`** が必要です。これらが無いと Discord が招待情報をBOTへ送信しないためです（チャンネルの管理: 作成された招待をリアルタイムで受信 / サーバー管理: サーバーの招待一覧を取得）。\n\nこれらの権限を含む招待リンクは `/invite` で取得できます。'
          }, {
            inline: true,
            name: '__記録できる範囲: メッセージログ__',
            value: `${global.bot.user.username} は、送信時点を見ていないメッセージの内容を削除時に表示できません。BOTの参加前や停止中に送信されたメッセージは、削除されても内容が表示されません。${retentionWindowClause(global.bot.user.username)}`
          }],
          footer: getEmbedFooter(global.bot.user),
          author: getAuthorField(interaction.member.user),
          thumbnail: {
            url: interaction.member.user.dynamicAvatarURL(null, 64)
          }
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      }).catch(() => {})
    } else if (interaction.data.options?.find(o => o.name === 'event')) {
      const eventName = interaction.data.options?.find(o => o.name === 'event').value
      if (!ALL_EVENTS.includes(eventName)) {
        return
      }
      interaction.createMessage({
        embeds: [{
          title: `${eventName} イベントの説明`,
          color: EMBED_COLORS.PURPLED_BLUE,
          footer: getEmbedFooter(global.bot.user),
          author: getAuthorField(interaction.member.user),
          description: `__**説明**__\n${EVENT_HELP[eventName]}\n\n*お探しの内容と違う場合は[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER})へお越しください。*`
        }],
        flags: Eris.Constants.MessageFlags.EPHEMERAL
      })
    }
  }
}
