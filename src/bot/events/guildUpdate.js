const escape = require('markdown-escape')
const send = require('../modules/webhooksender')

const checkExempt = [
  'afk_channel_id',
  'default_message_notifications',
  'system_channel_id',
  'afk_timeout'
]

const verificationLevels = {
  0: '制限なし',
  1: '低 - メール認証が必要',
  2: '中 - 登録から5分以上が必要',
  3: '高 - サーバー参加から10分以上が必要',
  4: '最高 - 電話番号認証が必要'
}

const explicitContentLevels = {
  0: 'スキャンしない',
  1: 'ロールを持たないメンバーをスキャン',
  2: 'すべてのメンバーをスキャン'
}

module.exports = {
  name: 'guildUpdate',
  type: 'on',
  handle: async (newGuild, oldGuild) => {
    const fields = []
    newGuild.getAuditLogs({ actionType: 1, limit: 1 }).then((log) => {
      if (!log || !log.entries || log.entries.length === 0 || new Date().getTime() - new Date((log.entries[0].id / 4194304) + 1420070400000).getTime() > 3000) return // this could be null coalesced but why not make it backwards compatible
      const user = log.entries[0].user
      const member = newGuild.members.get(user.id)
      let arr
      // This is the only instance where referring to an audit log by position returned is okay.
      // Results are returned sorted by id (newer id is a larger number & comes up first)
      if (Object.keys(log.entries[0].before) > Object.keys(log.entries[0].after)) {
        arr = Object.keys(log.entries[0].before)
      } else {
        arr = Object.keys(log.entries[0].after)
      }
      arr.forEach((key) => {
        if (log.entries[0].before[key] !== log.entries[0].after[key] || checkExempt.includes(key)) { // if both guilds have the property and they don't equal eachother
          const data = handle(key, log.entries[0])
          if (data) fields.push(data)
        }
      })
      if (fields.length === 0) return
      send({
        guildID: newGuild.id,
        eventName: 'guildUpdate',
        embeds: [{
          author: {
            name: `${user.username}#${user.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`,
            icon_url: user.avatarURL
          },
          description: 'サーバー設定が変更されました',
          fields: fields,
          color: 3553599
        }]
      })
    }).catch(() => {})
    // TODO: handle new guild updates, son! (update: will jump on this next, see project board on github)
    function handle (name, logEntry) {
      let after = 'なし'
      let before = 'なし'
      switch (name) {
        case 'system_channel_id':
          if (logEntry.before.system_channel_id) {
            before = logEntry.before.system_channel_id ? newGuild.channels.get(logEntry.before.system_channel_id).name : 'なし'
          }
          if (logEntry.after.system_channel_id) {
            after = logEntry.after.system_channel_id ? newGuild.channels.get(logEntry.after.system_channel_id).name : 'なし'
          }
          return {
            name: 'ウェルカムメッセージチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'afk_timeout':
          if (logEntry.before.afk_timeout) {
            before = logEntry.before.afk_timeout / 60
          }
          if (logEntry.after.afk_timeout) {
            after = logEntry.after.afk_timeout / 60
          }
          return {
            name: 'AFKタイムアウト',
            value: `► 変更後: **${after}** 分\n► 変更前: **${before}** 分`
          }
        case 'default_message_notifications':
          if (logEntry.before.default_message_notifications !== undefined) {
            before = logEntry.before.default_message_notifications === 0 ? 'すべてのメッセージ' : 'メンションのみ'
          }
          if (logEntry.after.default_message_notifications !== undefined) {
            after = logEntry.after.default_message_notifications === 0 ? 'すべてのメッセージ' : 'メンションのみ'
          }
          return {
            name: '通知設定',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'afk_channel_id':
          const beforeChannel = logEntry.before && newGuild.channels.get(logEntry.before.afk_channel_id)
          const afterChannel = logEntry.after && newGuild.channels.get(logEntry.after.afk_channel_id)
          if (!beforeChannel) {
            before = 'なし'
          } else {
            before = beforeChannel.name
          }
          if (!afterChannel) {
            after = 'なし'
          } else {
            after = afterChannel.name
          }
          return {
            name: 'AFKチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'name':
          before = logEntry.before.name
          after = logEntry.after.name
          return {
            name: '名前',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'region':
          before = logEntry.before.region
          after = logEntry.after.region
          return {
            name: 'リージョン',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'icon':
          before = '取得不可'
          after = newGuild.icon ? `[This](\`https://cdn.discordapp.com/icons/${newGuild.id}/${newGuild.icon}.jpg\`)` : 'なし'
          return {
            name: 'アイコン',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'features':
          before = '取得不可'
          after = '取得不可'
          return {
            name: 'サーバー機能 ⚠ 注意: 頻繁には変更されません',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'splash':
          before = '取得不可'
          after = '取得不可'
          return {
            name: 'スプラッシュ画像 ⚠ 注意: 頻繁には変更されません',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'verification_level':
          return {
            name: '認証レベル',
            value: verificationLevels[logEntry.after.verification_level]
          }
        case 'mfa_level':
          before = logEntry.before.mfa_level === 1 ? '有効' : '無効'
          after = logEntry.after.mfa_level === 1 ? '有効' : '無効'
          return {
            name: '二要素認証レベル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'explicit_content_filter':
          before = explicitContentLevels[logEntry.before.explicit_content_filter]
          after = explicitContentLevels[logEntry.after.explicit_content_filter]
          return {
            name: '不適切なコンテンツフィルター',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'widget_enabled':
          before = logEntry.before.widget_enabled ? '有効' : '無効'
          after = logEntry.after.widget_enabled ? '有効' : '無効'
          return {
            name: 'ウィジェット',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'rules_channel_id':
          before = logEntry.before.rules_channel_id ? global.bot.getChannel(logEntry.before.rules_channel_id).name || 'なし' : 'なし',
          after = logEntry.after.rules_channel_id ? global.bot.getChannel(logEntry.after.rules_channel_id).name || 'なし' : 'なし'
          return {
            name: 'ルールチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'public_updates_channel_id':
          before = logEntry.before.public_updates_channel_id ? global.bot.getChannel(logEntry.before.public_updates_channel_id).name || 'なし' : 'なし',
          after = logEntry.after.public_updates_channel_id ? global.bot.getChannel(logEntry.after.public_updates_channel_id).name || 'なし' : 'なし'
          return {
            name: '公開アップデートチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'preferred_locale':
          before = logEntry.before.preferred_locale
          after = logEntry.after.preferred_locale
          return {
            name: 'サーバーの言語',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'description':
          before = logEntry.before.description
          after = logEntry.after.description
          return {
            name: 'サーバーの説明',
            value: `► 変更後: **${escape(after)}**\n► 変更前: **${escape(before)}**`
          }
      }
    }
  }
}
