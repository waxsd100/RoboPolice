const send = require('../modules/webhooksender')
const inviteCache = require('../modules/invitecache')
const altDetector = require('../modules/altDetector')
const crossServerBan = require('../modules/crossServerBan')

module.exports = {
  name: 'guildMemberAdd',
  type: 'on',
  handle: async (guild, member) => {
    const GMAEvent = {
      guildID: guild.id,
      eventName: 'guildMemberAdd',
      embeds: [{
        author: {
          name: `${member.username}#${member.discriminator}`,
          icon_url: member.avatarURL
        },
        description: `<@${member.id}> が参加しました`,
        fields: [{
          name: '名前',
          value: `${member.username}#${member.discriminator} (${member.id}) ${member.mention}`
        }, {
          name: '参加日時',
          value: `<t:${Math.round(Date.now() / 1000)}:F>`
        }, {
          name: 'アカウント作成からの日数',
          value: `**${Math.floor((new Date() - member.user.createdAt) / 86400000)}** 日`,
          inline: true
        },
        {
          name: 'メンバー数',
          value: guild.memberCount.toLocaleString(),
          inline: true
        }],
        color: 65280
      }]
    }
    if (!member.username) { // No username? nope.
      return
    }
    let usedInviteCode = null
    const botPerms = guild.members.get(global.bot.user.id)?.permissions?.json
    if (botPerms?.manageGuild && botPerms?.manageChannels) {
      let guildInvites
      try {
        guildInvites = (await guild.getInvites()).map(i => inviteCache.formatInvite(i, false))
        const cachedInvites = await inviteCache.getCachedInvites(guild.id)
        let usedInvite
        if (guildInvites.length > cachedInvites.length) {
        // invite desync between redis and Discord, fix it
          await inviteCache.cacheInvitesWhole(guild.id, guildInvites)
        } else {
          usedInvite = compareInvites(guildInvites, cachedInvites)
        }
        if (!usedInvite) {
          if (guild.vanityURL != null) {
            GMAEvent.embeds[0].fields.push({
              name: '使用された招待',
              value: 'サーバーのカスタムURL',
              inline: true
            })
          } else if (member.bot) {
            GMAEvent.embeds[0].fields.push({
              name: '使用された招待',
              value: 'OAuth連携',
              inline: true
            })
          }
        }
        if (usedInvite) {
          usedInviteCode = usedInvite.code || null
          GMAEvent.embeds[0].fields.push({
            name: '使用された招待',
            value: `${usedInvite.code}（使用回数 ${usedInvite.uses.toLocaleString()}）`,
            inline: true
          })
        }
        await inviteCache.cacheInvitesWhole(guild.id, guildInvites)
      } catch (_) {
        console.error(_)
      // They're denying the bot the permissions it needs.
      }
    }
    GMAEvent.embeds[0].fields.push({
      name: 'ID',
      value: `\`\`\`ini\nメンバー = ${member.id}\nサーバー = ${guild.id}\`\`\``
    })
    await send(GMAEvent)
    altDetector.onMemberJoin(guild, member, { inviteCode: usedInviteCode }).catch(e => {
      global.logger?.warn(`[ALT]: onMemberJoin failed in ${guild.id}: ${e.message}`)
    })
    crossServerBan.onMemberJoin(guild, member).catch(e => {
      global.logger?.warn(`[XBAN]: onMemberJoin failed in ${guild.id}: ${e.message}`)
    })
  }
}

function compareInvites (current, saved) {
  const toIter = (current.length >= saved.length ? current : saved)
  for (let i = 0; i < toIter.length; i++) {
    const savedInvite = saved.find(inv => inv.code === toIter[i].code)
    const currentInvite = current.find(inv => inv.code === toIter[i].code)
    if (!savedInvite || !currentInvite) return null // if either is missing we shouldn't compare whatsoever
    if (savedInvite.uses !== currentInvite.uses) {
      return toIter[i]
    }
  }
}
