// %debugfooter [on|off]: whether mention replies in this server end with the debug line in small
// grey text (the models that answered, the Gemini tokens they used, what fell back). Off by
// default; for the bot's developers (CREATOR_IDS). Without an argument it says how it is now.
const store = require('../../db/interfaces/postgres/replySettings')

module.exports = {
  func: async (message, suffix) => {
    const guildID = message.channel.guild.id
    const arg = String(suffix || '').trim().toLowerCase()
    const say = content => message.channel.createMessage({ content, messageReference: { messageID: message.id } })
    try {
      if (!arg) {
        const { debugFooter } = await store.getReplySettings(guildID)
        return say(`このサーバーのデバッグ表示（返信の下のモデル・トークン）は${debugFooter ? 'オン' : 'オフ'}です。\`${process.env.GLOBAL_BOT_PREFIX}debugfooter on\` / \`off\` で切り替えます。`)
      }
      if (!['on', 'off'].includes(arg)) return say(`\`${process.env.GLOBAL_BOT_PREFIX}debugfooter on\` か \`off\` を指定してください。`)
      await store.setDebugFooter(guildID, arg === 'on')
      return say(`このサーバーのデバッグ表示を${arg === 'on' ? 'オン' : 'オフ'}にしました。`)
    } catch (e) {
      global.logger.warn(`Could not change the debug footer of ${guildID}: ${e.message}`)
      return say('設定を変えられませんでした。')
    }
  },
  name: 'debugfooter',
  description: 'Bot owner debug command.',
  type: 'creator',
  noDM: true,
  hidden: true
}
