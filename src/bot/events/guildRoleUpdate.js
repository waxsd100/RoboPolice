const send = require('../modules/webhooksender')
const { formatPermission } = require('../utils/displayLabels')

// What a changed property of a role is called in the log.
const PROP_LABELS = { name: '名前', color: '色', hoist: 'メンバーを別枠で表示', mentionable: 'メンション可能', icon: 'アイコン', unicodeEmoji: '絵文字', managed: '連携による管理' }
const labelOf = prop => PROP_LABELS[prop] || toTitleCase(prop)

module.exports = {
  name: 'guildRoleUpdate',
  type: 'on',
  handle: async (guild, role, oldRole) => {
    if (!guild || !role || !oldRole) return
    const guildRoleUpdateEvent = {
      guildID: guild.id,
      eventName: 'guildRoleUpdate',
      who: null,
      embeds: [{
        description: `ロールが更新されました (${role.name})`,
        fields: [],
        color: role.color ? role.color : 3553599
      }]
    }
    const oldKeys = Object.keys(oldRole)
    oldKeys.forEach(prop => {
      if (role[prop] !== oldRole[prop] && prop !== 'position' && prop !== 'permissions' && prop !== 'tags') {
        if (prop === 'color') {
          guildRoleUpdateEvent.embeds[0].fields.unshift({
            name: labelOf(prop),
            value: `変更後: ${intToHex(role[prop])}\n変更前: ${intToHex(oldRole[prop])}`
          })
        } else {
          guildRoleUpdateEvent.embeds[0].fields.unshift({
            name: labelOf(prop),
            value: `変更後: ${role[prop]}\n変更前: ${oldRole[prop]}`
          })
        }
      }
    })
    if (role.permissions && oldRole.permissions && (role.permissions.allow !== oldRole.permissions.allow || role.permissions.deny !== oldRole.permissions.deny)) {
      const field = {
        name: '権限の変更',
        value: ''
      }
      const newJson = role.permissions.json || {}
      const oldJson = oldRole.permissions.json || {}
      const newPerms = Object.keys(newJson)
      const oldPerms = Object.keys(oldJson)
      const differentPerms = [...new Set([...newPerms, ...oldPerms])]
      differentPerms.forEach(perm => {
        const hasNew = Object.prototype.hasOwnProperty.call(newJson, perm)
        const hasOld = Object.prototype.hasOwnProperty.call(oldJson, perm)
        if (hasNew && hasOld) {
          if (newJson[perm] === true && oldJson[perm] === false) {
            field.value += `\n+ ${formatPermission(perm, 'ja')}`
          } else if (newJson[perm] === false && oldJson[perm] === true) {
            field.value += `\n− ${formatPermission(perm, 'ja')}`
          }
        } else if (hasNew && !hasOld) {
          if (newJson[perm]) {
            field.value += `\n+ ${formatPermission(perm, 'ja')}`
          } else {
            field.value += `\n− ${formatPermission(perm, 'ja')}`
          }
        } else if (!hasNew && hasOld) {
          field.value += `\n− ${formatPermission(perm, 'ja')}`
        }
      })
      if (field.value) guildRoleUpdateEvent.embeds[0].fields.push(field)
    }
    const timer = setTimeout(async () => {
      const canViewAudit = guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
      const logs = canViewAudit && typeof guild.getAuditLog === 'function'
        ? await guild.getAuditLog({ limit: 5, actionType: 31 }).catch(() => ({ entries: [], users: [] }))
        : { entries: [], users: [] }
      const entries = Array.isArray(logs?.entries) ? logs.entries : []
      // Of this role: another role updated in the same seconds used to be taken for this one,
      // naming the wrong person.
      const log = entries.find(e => e.targetID === role.id && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
      if (log && log.user) {
        guildRoleUpdateEvent.embeds[0].fields.push({
          name: 'ID',
          value: `\`\`\`ini\nロール = ${role.id}\n実行者 = ${log.user.id}\`\`\``
        })
        guildRoleUpdateEvent.embeds[0].author = {
          name: `${log.user.username}#${log.user.discriminator}`,
          icon_url: log.user.avatarURL
        }
        if (guildRoleUpdateEvent.embeds[0].fields.length === 1) return
        await send(guildRoleUpdateEvent)
      } else {
        guildRoleUpdateEvent.embeds[0].fields.push({
          name: 'ID',
          value: `\`\`\`ini\nロール = ${role.id}\n実行者 = 不明\`\`\``
        })
        if (guildRoleUpdateEvent.embeds[0].fields.length === 1) return
        await send(guildRoleUpdateEvent)
      }
    }, 1000)
    timer.unref?.()
  }
}

function intToHex (num) {
  num >>>= 0
  const b = num & 0xFF
  const g = (num & 0xFF00) >>> 8
  const r = (num & 0xFF0000) >>> 16
  return rgbToHex(r, g, b)
}

function toTitleCase (str) {
  return str.replace(/\w\S*/g, function (txt) { return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase() })
}

function rgbToHex (r, g, b) { // bitwise math is black magic
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)
}
