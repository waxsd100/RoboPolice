// Which servers come first. The owner's servers (OWNER_GUILD_IDS, comma-separated) get the looser
// mention limits and go first in everything done in the background; every other server waits for
// them (backgroundQueue.js, and the order background jobs go through servers and stored rows).
const DEFAULT_OWNER_GUILDS = '615170683068219393'

function ownerGuildIDs () {
  return (process.env.OWNER_GUILD_IDS ?? DEFAULT_OWNER_GUILDS).split(',').map(s => s.trim()).filter(Boolean)
}

function isOwnerGuild (guildID) {
  return !!guildID && ownerGuildIDs().includes(String(guildID))
}

// `items` with those of the owner's servers first, otherwise in the order given.
function ownerFirst (items, guildOf = item => item) {
  return [...items].sort((a, b) => Number(isOwnerGuild(guildOf(b))) - Number(isOwnerGuild(guildOf(a))))
}

module.exports = { ownerGuildIDs, isOwnerGuild, ownerFirst }
