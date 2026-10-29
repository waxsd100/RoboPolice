const deleteGuild = require('../../db/interfaces/postgres/delete').deleteGuild
const { deleteGuildYouTube } = require('../../db/interfaces/postgres/youtube')

module.exports = {
  name: 'guildDelete',
  type: 'on',
  handle: async guild => {
    await deleteGuild(guild.id)
    await deleteGuildYouTube(guild.id)
  }
}
