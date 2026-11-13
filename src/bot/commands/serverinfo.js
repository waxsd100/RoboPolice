const escape = require('markdown-escape')

module.exports = {
  func: async message => {
    if (!message?.channel?.guild) return
    const guild = message.channel.guild
    const owner = global.bot.users.get(guild.ownerID)
    const channels = [...(guild.channels?.values?.() || [])]
    const createdMs = guild.createdAt || Number((BigInt(guild.id) >> 22n) + 1420070400000n)
    const createdSec = Math.floor(createdMs / 1000)
    const features = Array.isArray(guild.features) && guild.features.length !== 0
      ? guild.features.join(', ').slice(0, 1024)
      : 'なし'
    const embed = {
      description: `${guild.name} の情報`,
      color: 319403,
      fields: [{
        name: 'サーバー名',
        value: `**${guild.name}** (${guild.id})`
      }, {
        name: '作成日時',
        value: `<t:${createdSec}:F> (<t:${createdSec}:R>)`
      }, {
        name: 'メンバー数',
        value: `${guild.memberCount ?? guild.members?.size ?? 0}`
      }, {
        name: '認証レベル',
        value: `${guild.verificationLevel}`
      }, {
        name: 'オーナー',
        value: `${owner ? `**${owner.username}#${owner.discriminator}** ` : ''}(${guild.ownerID})`
      }, {
        name: 'サーバー機能',
        value: features
      }, {
        name: 'チャンネル数',
        value: `合計 **${channels.length}**\nテキスト **${channels.filter(c => c.type === 0).length}**\nボイス **${channels.filter(c => c.type === 2).length}**\nカテゴリ **${channels.filter(c => c.type === 4).length}**`
      }, {
        name: 'リージョン',
        value: `**${guild.region || '自動'}**`
      }, {
        name: 'ロール数',
        value: `${guild.roles?.size ?? 0}`
      }]
    }
    if (guild.iconURL) {
      embed.thumbnail = {
        url: guild.iconURL
      }
    }
    const availableEmojis = (guild.emojis || []).filter(e => e && e.available)
    if (availableEmojis.length === 0) {
      embed.fields.push({
        name: 'Emojis',
        value: 'なし'
      })
      await message.channel.createMessage({ embeds: [embed] })
    } else {
      const emojiObj = {
        0: []
      }
      let counter = 0 // Dynamically create embed fields based on character count
      availableEmojis.forEach(emoji => {
        const line = `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}> ${escape(emoji.name)} ${(emoji.roles || []).length !== 0 ? '<- 🔒 role restricted' : ''}`
        if ((emojiObj[counter].join('\n').length + line.length + 1) <= 1024) {
          emojiObj[counter].push(line)
        } else {
          counter++
          emojiObj[counter] = [line.slice(0, 1024)]
        }
      })
      const emojiFields = Object.keys(emojiObj).map(key => {
        return {
          name: 'Emojis',
          value: emojiObj[key].join('\n') || 'なし',
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
          embed.fields = embed.fields.concat(emojiFieldsToUse).slice(0, 25)
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
