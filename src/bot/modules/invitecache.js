// Redis 'EX' is in SECONDS. This was 10800000, i.e. 125 days, because a millisecond
// value was passed to a seconds parameter; 3 hours is what the value was written as.
const CACHE_TTL_SECONDS = 10800

const aes = require('../../db/aes')

const hasEncryptionKey = () => Boolean(process.env.AES_KEY && typeof process.env.AES_KEY === 'string')

module.exports = {
  getCachedInvites: async (guildID) => {
    // Why linvites? So the bot doesn't error on old stored invites lmao
    const invites = await global.redis.get(`linvites-${guildID}`)
    if (!invites) return []
    let parsed
    try {
      parsed = JSON.parse(invites)
    } catch (_) {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.map(invite => {
      if (!invite || !invite.code) return null
      const code = hasEncryptionKey() ? (aes.decrypt(invite.code) ?? invite.code) : invite.code
      if (!code) return null
      return {
        code,
        channel: invite.channel,
        uses: invite.uses
      }
    }).filter(Boolean)
  },
  cacheInvitesWhole: async (guildID, invitesArray) => {
    await global.redis.del(`linvites-${guildID}`)
    const safeArray = Array.isArray(invitesArray) ? invitesArray : []
    await global.redis.set(`linvites-${guildID}`, JSON.stringify(safeArray.map(i => module.exports.formatInvite(i, true))), 'EX', CACHE_TTL_SECONDS)
  },
  insertInvite: async (guildID, invite) => {
    const invites = await module.exports.getCachedInvites(guildID)
    invites.push(module.exports.formatInvite(invite, false))
    await global.redis.set(`linvites-${guildID}`, JSON.stringify(invites.map(i => module.exports.formatInvite(i, true))), 'EX', CACHE_TTL_SECONDS)
  },
  deleteInvite: async (guildID, code) => {
    const guildInvites = await module.exports.getCachedInvites(guildID)
    const inviteToDelete = guildInvites.find(i => i.code === code)
    if (!inviteToDelete) return // no more work to be done
    guildInvites.splice(guildInvites.indexOf(inviteToDelete), 1)
    await global.redis.set(`linvites-${guildID}`, JSON.stringify(guildInvites.map(i => ({
      ...i,
      code: hasEncryptionKey() ? (aes.encrypt(i.code) ?? i.code) : i.code
    }))), 'EX', CACHE_TTL_SECONDS)
  },
  formatInvite: (invite, doEncrypt) => { // strip useless info and only keep what I want
    if (!invite) throw new Error('Invite given to be stripped is null-ish')
    return {
      code: (doEncrypt && hasEncryptionKey()) ? (aes.encrypt(invite.code) ?? invite.code) : invite.code, // for formatting invites in guildMemberAdd
      channel: typeof invite.channel === 'string' ? invite.channel : (invite.channel && invite.channel.id), // lazy condition
      uses: `${invite.uses}${invite.maxUses ? `/${invite.maxUses}` : ''}`
    }
  }
}
