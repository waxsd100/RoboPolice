const { LEGAL_LINKS } = require('../utils/constants')
module.exports = {
  func: async (message, suffix) => {
    let DMC
    try {
      DMC = await message.author.getDMChannel()
    } catch (e) {
      message.channel.createMessage(`<@${message.author.id}> DMを受け取れない設定になっています。`).catch(() => {})
      return
    }

    if (suffix) {
      if (!global.bot.commands[suffix] || global.bot.commands[suffix]?.hidden) {
        return message.channel.createMessage(`<@${message.author.id}> そのようなコマンドはありません。\`${process.env.GLOBAL_BOT_PREFIX}help\` で全コマンドを確認できます。`)
      }
      await message.channel.createMessage({
        embeds: [{
          title: `${suffix} コマンドの説明`,
          description: global.bot.commands[suffix].quickHelp,
          fields: [{
            name: '使用例',
            value: global.bot.commands[suffix].examples
          }],
          color: 0xFFFFFF
        }]
      })
    } else {
      const embed = {
        description: `コマンドの一覧です。個別の詳細や使用例は ${process.env.GLOBAL_BOT_PREFIX}help コマンド名 で確認できます。`,
        color: 3553599,
        timestamp: new Date(),
        footer: {
          icon_url: global.bot.user.avatarURL,
          text: `${global.bot.user.username}#${global.bot.user.discriminator}`
        },
        thumbnail: {
          url: global.bot.user.avatarURL
        },
        author: {
          name: `${message.author.username}#${message.author.discriminator}`,
          icon_url: message.author.avatarURL
        },
        fields: []
      }
      Object.values(global.bot.commands).forEach(command => {
        if (!command.hidden) {
          embed.fields.push({
            name: command.name,
            value: `${command.quickHelp}\n\n使用例:\n${command.examples}`
          })
        }
      })
      try {
        await DMC.createMessage({
          embeds: [embed]
        })
        await DMC.createMessage({
          embeds: [{
            description: 'ヘルプの続き',
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
              value: `[プライバシーポリシー](${LEGAL_LINKS.PRIVACY_POLICY}) | [利用規約](${LEGAL_LINKS.TERMS_OF_SERVICE})\nデータの取り扱いについてのご質問は[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER})へどうぞ。`
            }, {
              inline: true,
              name: 'サポート',
              value: `個々のイベントの詳細は \`/help event: eventname\` で確認できます。うまく動かない場合は[サポートサーバー](${process.env.DISCORD_SUPPORT_SERVER})へお越しください。`
            }, {
              inline: false,
              name: '支援について',
              value: `このBOTを気に入っていただけた場合は \`@${process.env.BOT_CREATOR_NAME}\` までご連絡ください。`
            }],
          }]
        })
        await message.addReaction('📜')
      } catch (_) {
        message.addReaction('❌').catch(() => {})
        message.channel.createMessage(`<@${message.author.id}> ヘルプをDMで送信できませんでした。DMを受け取れる設定にするか、\`${process.env.GLOBAL_BOT_PREFIX}help コマンド名\` をご利用ください。`).catch(() => {})
      }
    }
  },
  name: 'help',
  quickHelp: 'ヘルプをDMで送信します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}help\` <- 全コマンドのヘルプをDMで送信
  \`${process.env.GLOBAL_BOT_PREFIX}help setchannel\` <- 各コマンドの詳細（使用例）を表示`,
  type: 'any',
  category: 'General'
}
