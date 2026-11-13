const Eris = require('eris')

module.exports = {
  name: 'setcmds',
  type: 'creator',
  func: async interaction => {
    const resolved = require.resolve('../utils/slashcommandconstants')
    delete require.cache[resolved]
    const { developerCommands, commands } = require('../utils/slashcommandconstants')
    let deferred = false
    if (typeof interaction.defer === 'function') {
      await interaction.defer(Eris.Constants.MessageFlags.EPHEMERAL)
      deferred = true
    }
    const reply = content => deferred && typeof interaction.editOriginalMessage === 'function'
      ? interaction.editOriginalMessage({ content })
      : interaction.createMessage({ content, flags: Eris.Constants.MessageFlags.EPHEMERAL })
    try {
      const scope = interaction.data?.options?.find(o => o.name === 'scope')?.value
      const guildID = interaction.guildID || interaction.channel?.guild?.id
      if (scope === 'guild') {
        if (!guildID) return await reply('guild スコープはサーバー内でのみ実行できます。')
        const all = [...commands, ...developerCommands]
        await global.bot.bulkEditGuildCommands(guildID, all)
        await reply(`このサーバーに ${all.length} 件のスラッシュコマンドを登録しました`)
        global.logger.info(`Guild set ${all.length} slash commands successfully`)
      } else if (scope === 'global') {
        await global.bot.bulkEditCommands(commands)
        await reply(`${commands.length} 件のスラッシュコマンドをグローバルに登録しました`)
        global.logger.info(`Globally set ${commands.length} slash commands successfully`)
      } else {
        await reply('使い方が正しくありません。scope には guild か global を指定してください。')
      }
    } catch (e) {
      global.logger.error('Error setting guild slash commands', e)
      await reply(`スラッシュコマンドの登録に失敗しました:\n${e?.message}`).catch(() => {})
    }
  }
}
