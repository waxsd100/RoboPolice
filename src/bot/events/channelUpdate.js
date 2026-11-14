const send = require('../modules/webhooksender')
const escape = require('markdown-escape')
const CHANNEL_TYPE_MAP = {
  0: 'テキストチャンネル',
  2: 'ボイスチャンネル',
  4: 'カテゴリ',
  5: 'アナウンスチャンネル',
  13: 'ステージチャンネル',
  15: 'フォーラムチャンネル'
}

const isRoleOverwrite = type => type === 0 || type === 'role'
const isMemberOverwrite = type => type === 1 || type === 'member'

function toArray (collectionOrMap) {
  if (!collectionOrMap) return []
  if (Array.isArray(collectionOrMap)) return [...collectionOrMap]
  if (typeof collectionOrMap.values === 'function') return [...collectionOrMap.values()]
  if (typeof collectionOrMap.map === 'function') return collectionOrMap.map(o => o)
  return []
}

function getAuditLogSafe (guild, query) {
  if (guild?.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') === false) {
    return Promise.resolve({ entries: [], users: [] })
  }
  if (typeof guild?.getAuditLog !== 'function') {
    return Promise.resolve({ entries: [], users: [] })
  }
  return guild.getAuditLog(query).catch(() => ({ entries: [], users: [] }))
}

const canUseExternal = guild => {
  const logChannelID = global.bot.guildSettingsCache[guild.id]?.event_logs?.channelUpdate
  if (logChannelID) {
    const logChannel = global.bot.getChannel(logChannelID)
    const permOverwrite = !!logChannel?.permissionOverwrites?.get?.(guild.id)?.json?.useExternalEmojis
    if (permOverwrite) return true
  }
  return !!guild.roles?.get?.(guild.id)?.permissions?.json?.useExternalEmojis
}

module.exports = {
  name: 'channelUpdate',
  type: 'on',
  handle: async (channel, oldChannel) => { // ignore updates of dm and group channels
    if (!channel || !oldChannel || !channel.guild) return
    if (channel.type === 1 || channel.type === 3) return
    if (channel.position !== oldChannel.position) return // flawed logic
    const guildSettings = global.bot.guildSettingsCache[channel.guild.id]
    if (guildSettings?.isChannelIgnored?.(channel.id)) return
    const channelUpdateEvent = {
      guildID: channel.guild.id,
      eventName: 'channelUpdate',
      embeds: [{
        author: {
          name: '不明なユーザー',
          icon_url: 'https://logger.bot/staticfiles/red-x.png'
        },
        color: 0x03d3fc,
        description: `${CHANNEL_TYPE_MAP[channel.type] ? CHANNEL_TYPE_MAP[channel.type] : '非対応のチャンネル'} <#${channel.id}> が更新されました (${escape(channel.name || '')})`,
        fields: [{
          name: '作成日時',
          value: `<t:${Math.round(((channel.id / 4194304) + 1420070400000) / 1000)}:F>`,
          inline: true
        }]
      }]
    }
    let channelOverwrites = toArray(channel.permissionOverwrites)
    let oldOverwrites = toArray(oldChannel.permissionOverwrites)
    const addedOverwrites = channelOverwrites.filter(nw => !oldOverwrites.some(ow => ow.id === nw.id))
    const removedOverwrites = oldOverwrites.filter(ow => !channelOverwrites.some(nw => nw.id === ow.id))

    const topicChanged = (channel.topic || '').trim() !== (oldChannel.topic || '').trim()
    let auditLogId
    if (addedOverwrites.length > 0) {
      auditLogId = 13
      channelOverwrites = channelOverwrites.filter(val => !addedOverwrites.includes(val))
    } else if (removedOverwrites.length > 0) {
      auditLogId = 15
      oldOverwrites = oldOverwrites.filter(val => !removedOverwrites.includes(val))
    } else if (topicChanged || channel.nsfw !== oldChannel.nsfw || channel.name !== oldChannel.name || channel.rateLimitPerUser !== oldChannel.rateLimitPerUser || channel.bitrate !== oldChannel.bitrate || channel.rtcRegion !== oldChannel.rtcRegion || channel.videoQualityMode !== oldChannel.videoQualityMode || channel.userLimit !== oldChannel.userLimit) {
      auditLogId = 11
    } else {
      auditLogId = 14
    }

    const logs = await getAuditLogSafe(channel.guild, { limit: 5, actionType: auditLogId })
    const entries = Array.isArray(logs?.entries) ? logs.entries : []
    const log = entries.find(e => e.targetID === channel.id)
    const user = log?.user
    if (user?.bot && !guildSettings?.isLogBots?.()) return

    if (auditLogId === 11) {
      let beforeMap = log?.before || null
      let afterMap = log?.after || null
      if (!beforeMap && !afterMap) {
        beforeMap = {}
        afterMap = {}
        if (topicChanged) { beforeMap.topic = oldChannel.topic; afterMap.topic = channel.topic }
        if (channel.name !== oldChannel.name) { beforeMap.name = oldChannel.name; afterMap.name = channel.name }
        if (channel.nsfw !== oldChannel.nsfw) { beforeMap.nsfw = oldChannel.nsfw; afterMap.nsfw = channel.nsfw }
        if (channel.rateLimitPerUser !== oldChannel.rateLimitPerUser) { beforeMap.rate_limit_per_user = oldChannel.rateLimitPerUser; afterMap.rate_limit_per_user = channel.rateLimitPerUser }
        if (channel.bitrate !== oldChannel.bitrate) { beforeMap.bitrate = oldChannel.bitrate; afterMap.bitrate = channel.bitrate }
        if (channel.rtcRegion !== oldChannel.rtcRegion) { beforeMap.rtc_region = oldChannel.rtcRegion; afterMap.rtc_region = channel.rtcRegion }
        if (channel.videoQualityMode !== oldChannel.videoQualityMode) { beforeMap.video_quality_mode = oldChannel.videoQualityMode; afterMap.video_quality_mode = channel.videoQualityMode }
        if (channel.userLimit !== oldChannel.userLimit) { beforeMap.user_limit = oldChannel.userLimit; afterMap.user_limit = channel.userLimit }
      }
      beforeMap = beforeMap || {}
      afterMap = afterMap || {}
      const toIter = Object.keys(beforeMap).length >= Object.keys(afterMap).length ? beforeMap : afterMap
      for (const changedKey in toIter) {
        if (changedKey === 'topic') {
          const rawNewTopic = (channel.topic || '').trim()
          const rawOldTopic = (oldChannel.topic || '').trim()
          if (rawNewTopic === rawOldTopic) continue
          const newTopic = rawNewTopic ? escape(rawNewTopic.replace(/~/g, '\\~'), ['angle brackets']) : '<トピック未設定>'
          const oldTopic = rawOldTopic ? escape(rawOldTopic.replace(/~/g, '\\~'), ['angle brackets']) : '<トピック未設定>'
          if (newTopic.length + oldTopic.length > 950) {
            channelUpdateEvent.embeds[0].description += `\n\n**__New topic__**\n\`${newTopic}\`\n\n**__Old topic__**\n\`${oldTopic}\``
          } else {
            channelUpdateEvent.embeds[0].fields.push({
              name: 'トピック',
              value: `Now: \`${newTopic}\`\nWas: \`${oldTopic}\``
            })
          }
          // using `` to surround topic because topic can be just spaces
          continue
        }
        if (changedKey === 'tags') continue
        const changes = transformAuditLogEntry(changedKey, beforeMap[changedKey], afterMap[changedKey])
        channelUpdateEvent.embeds[0].fields.push({
          name: toTitleCase(changedKey),
          value: `Now: ${changes.after}\nWas: ${changes.before}`
        })
      }
    } else {
      const beforeObj = log?.before || {}
      const afterObj = log?.after || {}
      if ((Object.keys(afterObj).length !== 0 && Object.keys(beforeObj).length === 0) || (!log && addedOverwrites.length > 0)) {
        const targetOw = Object.keys(afterObj).length !== 0 ? afterObj : addedOverwrites[0]
        if (isRoleOverwrite(targetOw.type)) {
          const nRole = channel.guild.roles?.get?.(targetOw.id)
          channelUpdateEvent.embeds[0].fields.push({
            name: '権限の上書きを追加',
            value: `対象: ロール ${nRole ? nRole.name : targetOw.id}`
          })
          channelUpdateEvent.embeds[0].color = nRole?.color || 0x03d3fc
        } else {
          channelUpdateEvent.embeds[0].fields.push({
            name: '権限の上書きを追加',
            value: `対象: メンバー <@${targetOw.id}>`
          })
        }
      } else if ((Object.keys(beforeObj).length !== 0 && Object.keys(afterObj).length === 0) || (!log && removedOverwrites.length > 0)) {
        const targetOw = Object.keys(beforeObj).length !== 0 ? beforeObj : removedOverwrites[0]
        if (isRoleOverwrite(targetOw.type)) {
          const role = channel.guild.roles?.get?.(targetOw.id)
          channelUpdateEvent.embeds[0].fields.push({
            name: '権限の上書きを削除',
            value: `対象: ロール ${role ? role.name : targetOw.id}`
          })
          channelUpdateEvent.embeds[0].color = role?.color || 0x03d3fc
        } else {
          channelUpdateEvent.embeds[0].fields.push({
            name: '権限の上書きを削除',
            value: `対象: メンバー <@${targetOw.id}>`
          })
        }
      } else {
        const newSig = toArray(channel.permissionOverwrites).map(o => `${o.id}:${o.allow}|${o.deny}`).toString()
        const oldSig = toArray(oldChannel.permissionOverwrites).map(o => `${o.id}:${o.allow}|${o.deny}`).toString()
        if (newSig !== oldSig) {
          channelOverwrites.forEach(newOverwrite => {
            const oldOverwrite = oldOverwrites.find(ow => ow.id === newOverwrite.id)
            if (!newOverwrite?.json || !oldOverwrite?.json) return
            const newPerms = Object.keys(newOverwrite.json)
            const oldPerms = Object.keys(oldOverwrite.json)
            const differentPerms = [...new Set([...newPerms, ...oldPerms])]
            let overwriteName = `${isMemberOverwrite(newOverwrite.type) ? 'メンバー' : 'ロール'} `
            if (isMemberOverwrite(newOverwrite.type)) {
              const member = channel.guild.members?.get?.(newOverwrite.id)
              if (member) {
                overwriteName += member.username + (member.nick ? ` (${member.nick})` : '')
              } else {
                overwriteName += newOverwrite.id
              }
            } else if (isRoleOverwrite(newOverwrite.type)) {
              const role = channel.guild.roles?.get?.(newOverwrite.id)
              if (!role) return
              overwriteName += role.name
              if (role.color) channelUpdateEvent.embeds[0].color = role.color
            }
            const fields = [{ name: overwriteName, value: '' }]
            let counter = 0
            differentPerms.forEach(perm => { // This is black magic, but tl;dr it determines whether a perm was set to grant/deny/inherit
              if (fields[counter].value.length >= 950) {
                counter++
                fields.push({
                  name: `${overwriteName} 続き`,
                  value: ''
                })
              }
              const hasNew = Object.prototype.hasOwnProperty.call(newOverwrite.json, perm)
              const hasOld = Object.prototype.hasOwnProperty.call(oldOverwrite.json, perm)
              if (hasNew && hasOld) {
                if (newOverwrite.json[perm] === true && oldOverwrite.json[perm] === false) {
                  fields[counter].value += `\n${canUseExternal(channel.guild) ? '<:onswitch:1223589267398328402>' : 'ALLOW'} ${perm}`
                } else if (newOverwrite.json[perm] === false && oldOverwrite.json[perm] === true) {
                  fields[counter].value += `\n${canUseExternal(channel.guild) ? '<:offswitch:1223589245827154082>' : 'DENY'} ${perm}`
                }
              } else if (hasNew && !hasOld) {
                if (newOverwrite.json[perm]) {
                  fields[counter].value += `\n${canUseExternal(channel.guild) ? '<:onswitch:1223589267398328402>' : 'ALLOW'} ${perm}`
                } else {
                  fields[counter].value += `\n${canUseExternal(channel.guild) ? '<:offswitch:1223589245827154082>' : 'DENY'} ${perm}`
                }
              } else if (!hasNew && hasOld) {
                fields[counter].value += `\n⚖️ neutral/inherit ${perm}`
              }
            })
            for (let i = 0; i < fields.length; i++) {
              if (fields[i].value) {
                if (isMemberOverwrite(newOverwrite.type) && i === 0) {
                  fields[i].value = `<@${newOverwrite.id}>${fields[i].value}`
                }
                channelUpdateEvent.embeds[0].fields.push(fields[i])
              }
            }
          })
        }
      }
    }

    if (channelUpdateEvent.embeds[0].fields.length === 1 && !channelUpdateEvent.embeds[0].description.includes('**__New topic__**')) {
      return
    }

    if (log && user) {
      channelUpdateEvent.embeds[0].author.name = `${user.username}#${user.discriminator}`
      channelUpdateEvent.embeds[0].author.icon_url = user.avatarURL
      if (channel.type === 13) {
        channelUpdateEvent.embeds[0].description = `Stage Channel **${channel.name}** が${channel.topic === null ? '終了しました' : '開始しました'}`
      }
      channelUpdateEvent.embeds[0].fields.push({ name: 'ID', value: `\`\`\`ini\nユーザー = ${user.id}\nチャンネル = ${channel.id}\`\`\`` })
      await send(channelUpdateEvent)
    } else {
      channelUpdateEvent.embeds[0].fields.push({
        name: 'ID',
        value: `\`\`\`ini\nユーザー = 不明（監査ログなし）\nチャンネル = ${channel.id}\`\`\``
      })
      await send(channelUpdateEvent)
    }
  }
}

function toTitleCase (str) {
  return str.replace(/_/g, ' ').replace(/\w\S*/g, function (txt) { return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase() })
}

function transformAuditLogEntry (nameOfKey, before, after) {
  switch (nameOfKey) {
    case 'nsfw': {
      return { before: before ? 'enabled' : 'disabled', after: after ? 'enabled' : 'disabled' }
    }
    case 'topic': {
      return { before: before ? escape(before.replace(/~/g, '\\~'), ['angle brackets']) : '<トピック未設定>', after: after ? escape(after.replace(/~/g, '\\~'), ['angle brackets']) : '<トピック未設定>' }
    }
    case 'rate_limit_per_user': {
      return { before: `${before} second(s)`, after: `${after} seconds` }
    }
    case 'name': {
      return { before, after }
    }
    case 'type': {
      return { before: CHANNEL_TYPE_MAP[before], after: CHANNEL_TYPE_MAP[after] }
    }
    case 'bitrate': {
      return { before: `${parseInt(before) / 1000}kbps`, after: `${parseInt(after) / 1000}kbps` }
    }
    case 'rtc_region': {
      return { before: before || '自動', after: after || '自動' }
    }
    case 'video_quality_mode': {
      return { before: before === 1 ? '自動' : '720p', after: after === 1 ? '自動' : '720p' }
    }
    case 'user_limit': {
      return { before: before !== 0 ? before : 'unrestricted', after: after !== 0 ? after : 'unrestricted' }
    }
    default: {
      return { before: '<unknown>', after: '<unknown>' }
    }
  }
}
