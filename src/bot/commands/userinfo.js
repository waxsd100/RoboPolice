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
    if (!message?.channel?.guild) return
    let member = message.member
    if (Array.isArray(message.mentions) && message.mentions.length !== 0) {
      member = message.channel.guild.members?.get?.(message.mentions[0].id) || message.member
    }
    if (!member) return
    const fields = []
    const perms = []
    const permJson = member.permissions?.json || {}
    Object.keys(permJson).forEach((perm) => {
      if (permJson[perm] === true && notablePermissions.indexOf(perm) !== -1) {
        perms.push(`\`${perm}\``)
      }
    })
    const roles = (member.roles || [])
      .map(r => message.channel.guild.roles?.get?.(r))
      .filter(Boolean)
      .sort((a, b) => b.position - a.position)
    let rolesValue = roles.length !== 0 ? roles.map(c => `\`${c.name}\``).join(', ') : 'なし'
    if (rolesValue.length > 1024) {
      rolesValue = rolesValue.slice(0, 1021) + '...'
    }
    const createdMs = member.createdAt || Number((BigInt(member.id) >> 22n) + 1420070400000n)
    const createdSec = Math.floor(createdMs / 1000)
    const joinedSec = member.joinedAt ? Math.round(member.joinedAt / 1000) : null
    const defaultAvatarIndex = (!member.discriminator || member.discriminator === '0' || member.discriminator === '0000')
      ? Number((BigInt(member.id) >> 22n) % 6n)
      : Number(member.discriminator) % 5
    const avatarUrl = member.avatar
      ? (member.dynamicAvatarURL?.(null, 256) || member.avatarURL)
      : (member.defaultAvatarURL || `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`)
    fields.push({
      name: '名前',
      value: `${member.username}#${member.discriminator} ${member.nick ? `(**${member.nick}**)` : ''} (${member.id})`
    }, {
      name: '参加日時',
      value: joinedSec ? `<t:${joinedSec}:F> (<t:${joinedSec}:R>)` : '不明'
    }, {
      name: 'アカウント作成日時',
      value: `<t:${createdSec}:F> (<t:${createdSec}:R>)`
    }, {
      name: 'ロール',
      value: rolesValue
    }, {
      name: '主な権限',
      value: perms.length !== 0 ? perms.join(', ') : 'なし'
    })
    await message.channel.createMessage({
      embeds: [{
        timestamp: new Date(message.timestamp),
        color: roles.length !== 0 ? roles[0].color : 3553599,
        thumbnail: {
          url: avatarUrl
        },
        fields
      }]
    }).catch(() => {})
  },
  name: 'userinfo',
  quickHelp: 'メンション付きで実行するとそのユーザーの、引数なしで実行すると自分の情報を表示します。', // The restriction of using a mention is very intentional.
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}userinfo\` <- 自分の情報を表示
  \`${process.env.GLOBAL_BOT_PREFIX}userinfo @AnyUser\` <- メンションしたユーザーの情報を表示`,
  type: 'any',
  category: 'General'
}
