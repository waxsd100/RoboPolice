const send = require('../modules/webhooksender')
const cacheGuild = require('../utils/cacheGuild')
const arrayCompare = require('../utils/arraycompare')
const markdownEscape = require('markdown-escape')

const canUseExternal = guild => {
  const logChannelID = global.bot.guildSettingsCache[guild.id]?.event_logs?.guildMemberUpdate
  if (logChannelID) {
    const logChannel = global.bot.getChannel(logChannelID)
    const permOverwrite = !!logChannel?.permissionOverwrites?.get?.(guild.id)?.json?.useExternalEmojis
    if (permOverwrite) return true
  }
  return !!guild.roles?.get?.(guild.id)?.permissions?.json?.useExternalEmojis
}

module.exports = {
  name: 'guildMemberUpdate',
  type: 'on',
  handle: async (guild, member, oldMember) => {
    if (!guild || !member || !global.bot.guilds.get(guild.id)) { // don't try to log something when the bot isn't in the guild
      return
    }
    if (!global.bot.guildSettingsCache[guild.id]) {
      await cacheGuild(guild.id)
    }
    const guildSettings = global.bot.guildSettingsCache[guild.id]
    if (!guildSettings) return

    if (oldMember && member.nick !== oldMember.nick) { // if member is cached and nick is different
      if (member.bot && !guildSettings.isLogBots()) return
      const newNickValue = `${member.nick ? member.nick : member.username}#${member.discriminator}`
      if (newNickValue) {
        const nickEvent = {
          guildID: guild.id,
          eventName: 'guildMemberNickUpdate',
          embeds: [{
            description: `${member.mention} ${member.nick ? `(現在: ${member.nick})` : ''} のニックネームが変更されました`,
            fields: [
              {
                name: '変更後の名前',
                value: newNickValue
              },
              {
                name: '変更前の名前',
                value: `${oldMember.nick ? oldMember.nick : member.username}#${member.discriminator}`
              },
              {
                name: 'ID',
                value: `\`\`\`ini\nユーザー = ${member.id}\`\`\``
              }
            ]
          }]
        }
        await send(nickEvent)
      }
    } else if (oldMember?.pending && !member.pending && guild.features?.includes?.('MEMBER_VERIFICATION_GATE_ENABLED')) {
      const verifyEvent = {
        guildID: guild.id,
        eventName: 'guildMemberVerify',
        embeds: [{
          author: {
            name: `${member.username}#${member.discriminator}`,
            icon_url: member.avatarURL
          },
          description: `${member.mention} (${member.username}#${member.discriminator}: \`${member.id}\`) がメンバー認証を完了しました`,
          color: 0x1ced9a
        }]
      }
      await send(verifyEvent)
    } else if (oldMember && Array.isArray(oldMember.roles) && oldMember.premiumSince !== member.premiumSince) {
      const boostRole = [...(guild.roles?.values?.() || [])].find(r => r?.tags?.premium_subscriber === true)
      if (boostRole) {
        const oldMemberHasBoostRole = oldMember.roles.includes(boostRole.id)
        const newMemberHasBoostRole = Array.isArray(member.roles) && member.roles.includes(boostRole.id)
        if (oldMemberHasBoostRole !== newMemberHasBoostRole) { // something bugged and this was called when there wasn't really a boost update... although this doesn't log subsequent boosts by a current booster.
          const boostEvent = {
            guildID: guild.id,
            eventName: 'guildMemberBoostUpdate',
            embeds: [{
              author: {
                name: `${member.username}#${member.discriminator}`,
                icon_url: member.avatarURL
              },
              description: `${member.mention} がサーバーブーストを${newMemberHasBoostRole ? '開始しました' : '終了しました'}`,
              color: member.premiumSince ? 0x15cc12 : 0xeb4034
            }]
          }
          await send(boostEvent)
        }
      }
    }
    // if member cached and roles not different, stop here.
    if (oldMember && arrayCompare(member.roles || [], oldMember.roles || []) && (member.communicationDisabledUntil === oldMember.communicationDisabledUntil)) return // if roles are the same stop fetching audit logs
    const canViewAuditLog = guild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    if (!canViewAuditLog) return
    const logs = await guild.getAuditLog({ limit: 5 }).catch(() => ({ entries: [], users: [] }))
    if (!logs?.entries?.[0]) return
    const possibleRoleLog = logs.entries.find(e => e?.targetID === member.id && e.actionType === 25 && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
    const possibleTimeoutLog = logs.entries.find(e => e?.targetID === member.id && e.actionType === 24 && (e.before?.communication_disabled_until || e.after?.communication_disabled_until) && Date.now() - ((e.id / 4194304) + 1420070400000) < 3000)
    if (possibleRoleLog) {
      possibleRoleLog.guild = []
      const user = possibleRoleLog.user
      if (user == null) return
      if (user.bot && !guildSettings.isLogBots()) return
      const added = []
      const removed = []
      let roleColor
      if (Array.isArray(possibleRoleLog.after?.$add) && possibleRoleLog.after.$add.length !== 0) {
        possibleRoleLog.after.$add.forEach(r => added.push(r))
      }
      if (Array.isArray(possibleRoleLog.after?.$remove) && possibleRoleLog.after.$remove.length !== 0) {
        possibleRoleLog.after.$remove.forEach(r => removed.push(r))
      }
      if (added.length !== 0) {
        roleColor = guild.roles?.get?.(added[0].id)?.color
      }
      if (removed.length !== 0) {
        roleColor = guild.roles?.get?.(removed[0].id)?.color
      }
      // Add a + or - emoji when roles are manipulated for a user, stringify it, and assign a field value to it.
      let changeValue = `${added.map(role => `${canUseExternal(guild) ? '<:greenplus:1223588616786415646>' : '➕'} **${role.name}**`).join('\n')}${removed.map((role, i) => `${i === 0 && added.length !== 0 ? '\n' : ''}\n:x: **${role.name}**`).join('\n')}`
      if (!changeValue) return
      if (changeValue.length > 1024) {
        changeValue = changeValue.slice(0, 1021) + '...'
      }
      const roleUpdateEvent = {
        guildID: guild.id,
        eventName: 'guildMemberUpdate',
        embeds: [{
          author: {
            name: `${member.username}#${member.discriminator}`,
            icon_url: member.avatarURL
          },
          description: `${member.username}#${member.discriminator} ${member.mention} ${member.nick ? `(${member.nick})` : ''} の情報が更新されました`,
          color: roleColor,
          footer: {
            text: `${user.username}#${user.discriminator}`,
            icon_url: user.avatarURL
          },
          fields: [
            {
              name: '変更内容',
              value: changeValue
            },
            {
              name: 'ID',
              value: `\`\`\`ini\nユーザー = ${member.id}\n実行者 = ${user.id}\`\`\``
            }
          ]
        }]
      }
      await send(roleUpdateEvent)
    } else if (possibleTimeoutLog && possibleTimeoutLog.user) {
      const fields = [{
        name: 'タイムアウトの実行者',
        value: `${possibleTimeoutLog.user.username}#${possibleTimeoutLog.user.discriminator}`
      }]
      if (possibleTimeoutLog.reason) {
        fields.push({
          name: '理由',
          value: markdownEscape(possibleTimeoutLog.reason)
        })
      }
      if (member.communicationDisabledUntil) {
        fields.push({
          name: '有効期限',
          value: `<t:${Math.ceil(member.communicationDisabledUntil / 1000)}> (<t:${Math.ceil(member.communicationDisabledUntil / 1000)}:R>)`
        })
      } else if (possibleTimeoutLog.before?.communication_disabled_until) {
        const prevSec = Math.ceil(Date.parse(possibleTimeoutLog.before.communication_disabled_until) / 1000)
        if (!Number.isNaN(prevSec)) {
          fields.push({
            name: '有効期限',
            value: `変更前の期限: <t:${prevSec}> (<t:${prevSec}:R>)`
          })
        }
      }
      fields.push({
        name: 'ID',
        value: `\`\`\`ini\nユーザー = ${member.id}\n実行者 = ${possibleTimeoutLog.user.id}\`\`\``
      })
      const timeoutEvent = {
        guildID: guild.id,
        eventName: 'guildMemberUpdate',
        embeds: [{
          author: {
            name: `${member.username}#${member.discriminator}`,
            icon_url: member.avatarURL
          },
          description: `${member.username}#${member.discriminator} (${member.mention}) ${member.communicationDisabledUntil ? 'がタイムアウトされました' : 'のタイムアウトが解除されました'}`,
          footer: {
            text: `${possibleTimeoutLog.user.username}#${possibleTimeoutLog.user.discriminator}`,
            icon_url: possibleTimeoutLog.user.avatarURL
          },
          fields
        }]
      }
      await send(timeoutEvent)
    }
  }
}
