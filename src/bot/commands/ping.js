module.exports = {
  func: async message => {
    const start = new Date().getTime()
    const m = await message.channel.createMessage('計測中...')
    m.edit(`完了。RTT: ${new Date().getTime() - start} ms`)
  },
  name: 'ping',
  quickHelp: 'Discord との往復応答時間を計測します。',
  examples: `\`${process.env.GLOBAL_BOT_PREFIX}ping\``,
  type: 'any',
  category: 'General'
}
