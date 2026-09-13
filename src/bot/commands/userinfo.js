const notablePermissions = [
  'kickMembers',
  'banMembers',
  'administrator',
  'manageChannels',
  'manageGuild',
  'manageMessages',
  'manageRoles',
  'manageEmojis',
  'manageWebhooks',
  'prioritySpeaker'
]

module.exports = {
  func: async message => {
    let member = message.member
    if (message.mentions.length !== 0) member = message.channel.guild.members.get(message.mentions[0].id)
    const fields = []
    const perms = []
    Object.keys(member.permissions.json).forEach((perm) => {
      if (member.permissions.json[perm] === true && notablePermissions.indexOf(perm) !== -1) {
        perms.push(`\`${perm}\``)
      }
    })
    const roles = member.roles.map(r => message.channel.guild.roles.get(r)).sort((a, b) => b.position - a.position)
    fields.push({
      name: '名前',
      value: `${member.username}#${member.discriminator} ${member.nick ? `(**${member.nick}**)` : ''} (${member.id})`
    }, {
      name: '参加日時',
      value: `<t:${Math.round(member.joinedAt / 1000)}:F> (<t:${Math.round(member.joinedAt / 1000)}:R>)`
    }, {
      name: 'アカウント作成日時',
      value: `<t:${Math.round(((member.id / 4194304) + 1420070400000) / 1000)}:F>`
    }, {
      name: 'ロール',
      value: roles.length !== 0 ? roles.map(c => `\`${c.name}\``).join(', ') : 'なし'
    }, {
      name: '主な権限',
      value: perms.length !== 0 ? perms.join(', ') : 'なし'
    })
    message.channel.createMessage({
      embeds: [{
        timestamp: new Date(message.timestamp),
        color: roles.length !== 0 ? roles[0].color : 3553599,
        thumbnail: {
          url: member.avatar ? member.avatarURL : `https://cdn.discordapp.com/embed/avatars/${member.discriminator % 5}.png`
        },
        fields: fields
      }]
    }).catch(() => { })
  },
  name: 'userinfo',
  quickHelp: 'メンション付きで実行するとそのユーザーの、引数なしで実行すると自分の情報を表示します。', // The restriction of using a mention is very intentional.
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}userinfo\` <- 自分の情報を表示
  \`${process.env.GLOBAL_BOT_PREFIX}userinfo @AnyUser\` <- メンションしたユーザーの情報を表示`,
  type: 'any',
  category: 'General'
}
