const escape = require('markdown-escape')

module.exports = {
  func: async message => {
    const fields = []
    const owner = global.bot.users.get(message.channel.guild.ownerID)
    const embed = {
      description: `${message.channel.guild.name} の情報`,
      color: 319403,
      fields: [{
        name: 'サーバー名',
        value: `**${message.channel.guild.name}** (${message.channel.guild.id})`
      }, {
        name: '認証レベル',
        value: `${message.channel.guild.verificationLevel}`
      }, {
        name: 'オーナー',
        value: `${owner ? `**${owner.username}#${owner.discriminator}** ` : ''}(${message.channel.guild.ownerID})`
      }, {
        name: 'サーバー機能',
        value: message.channel.guild.features.length !== 0 ? message.channel.guild.features.join(', ') : 'なし'
      }, {
        name: 'チャンネル数',
        value: `合計 **${message.channel.guild.channels.size}**\nテキスト **${message.channel.guild.channels.filter(c => c.type === 0).length}**\nボイス **${message.channel.guild.channels.filter(c => c.type === 2).length}**\nカテゴリ **${message.channel.guild.channels.filter(c => c.type === 4).length}**`
      }, {
        name: 'リージョン',
        value: `**${message.channel.guild.region}**`
      }, {
        name: 'ロール数',
        value: `${message.channel.guild.roles.size}`
      }]
    }
    if (message.channel.guild.iconURL) {
      embed.thumbnail = {
        url: message.channel.guild.iconURL
      }
    }
    if (message.channel.guild.emojis.length === 0) {
      fields.push({
        name: 'Emojis',
        value: 'なし'
      })
      await message.channel.createMessage({ embeds: [embed] })
    } else {
      const emojiObj = {
        0: []
      }
      let counter = 0 // Dynamically create embed fields based on character count
      message.channel.guild.emojis.forEach(emoji => {
        if (emojiObj[counter].join('\n').length < 950) {
          if (!emoji.available) return
          emojiObj[counter].push(`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}> ${escape(emoji.name)} ${emoji.roles.length !== 0 ? '<- 🔒 role restricted' : ''}`)
        } else {
          if (!emoji.available) return
          counter++
          emojiObj[counter] = []
          emojiObj[counter].push(`<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`)
        }
      })
      const emojiFields = Object.keys(emojiObj).map(key => {
        return {
          name: 'Emojis',
          value: emojiObj[key].join('\n'),
          inline: true
        }
      })
      for (let i = 0; i < emojiFields.length; i++) {
        if (!emojiFields[i]) break
        if (i % 4 !== 0) continue
        const emojiFieldsToUse = [emojiFields[i]]
        if (emojiFields[i + 1]) emojiFieldsToUse.push(emojiFields[i + 1])
        if (emojiFields[i + 2]) emojiFieldsToUse.push(emojiFields[i + 2])
        if (emojiFields[i + 3]) emojiFieldsToUse.push(emojiFields[i + 3])
        if (i === 0) {
          embed.fields = embed.fields.concat(emojiFieldsToUse)
          await message.channel.createMessage({ embeds: [embed] })
        } else {
          await message.channel.createMessage({ embeds: [{ description: '絵文字（続き）', fields: emojiFieldsToUse }] })
        }
      }
    }
  },
  name: 'serverinfo',
  quickHelp: '現在のサーバーの情報（絵文字、オーナー、メンバー数など）を表示します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}serverinfo\``,
  type: 'any',
  category: 'Utility'
}
