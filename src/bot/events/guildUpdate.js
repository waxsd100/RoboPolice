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
    if (!newGuild) return
    require('../../db/interfaces/postgres/update').saveGuildDetails(newGuild).catch(e => global.logger.warn(`Could not save the details of ${newGuild.id}: ${e.message}`))
    const canViewAuditLog = newGuild.members?.get?.(global.bot.user.id)?.permissions?.has?.('viewAuditLog') !== false
    if (!canViewAuditLog) return
    const fields = []
    const log = await newGuild.getAuditLog({ actionType: 1, limit: 1 }).catch(() => ({ entries: [], users: [] }))
    if (!log || !Array.isArray(log.entries) || log.entries.length === 0 || new Date().getTime() - new Date((log.entries[0].id / 4194304) + 1420070400000).getTime() > 3000) return // this could be null coalesced but why not make it backwards compatible
    const entry = log.entries[0]
    const user = entry.user
    if (!user) return
    const member = newGuild.members?.get?.(user.id)
    const beforeObj = entry.before || {}
    const afterObj = entry.after || {}
    // This is the only instance where referring to an audit log by position returned is okay.
    // Results are returned sorted by id (newer id is a larger number & comes up first)
    const arr = Object.keys(beforeObj).length > Object.keys(afterObj).length
      ? Object.keys(beforeObj)
      : Object.keys(afterObj)
    arr.forEach((key) => {
      if (beforeObj[key] !== afterObj[key] || checkExempt.includes(key)) { // if both guilds have the property and they don't equal eachother
        const data = handle(key, entry)
        if (data) fields.push(data)
      }
    })
    if (fields.length === 0) return
    await send({
      guildID: newGuild.id,
      eventName: 'guildUpdate',
      embeds: [{
        author: {
          name: `${user.username}#${user.discriminator} ${member && member.nick ? `(${member.nick})` : ''}`,
          icon_url: user.avatarURL
        },
        description: 'サーバー設定が変更されました',
        fields,
        color: 3553599
      }]
    })
    // TODO: handle new guild updates, son! (update: will jump on this next, see project board on github)
    function handle (name, logEntry) {
      const b = logEntry.before || {}
      const a = logEntry.after || {}
      let after = 'なし'
      let before = 'なし'
      switch (name) {
        case 'system_channel_id':
          if (b.system_channel_id) {
            before = newGuild.channels?.get?.(b.system_channel_id)?.name || 'なし'
          }
          if (a.system_channel_id) {
            after = newGuild.channels?.get?.(a.system_channel_id)?.name || 'なし'
          }
          return {
            name: 'ウェルカムメッセージチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'afk_timeout':
          if (b.afk_timeout) {
            before = b.afk_timeout / 60
          }
          if (a.afk_timeout) {
            after = a.afk_timeout / 60
          }
          return {
            name: 'AFKタイムアウト',
            value: `► 変更後: **${after}** 分\n► 変更前: **${before}** 分`
          }
        case 'default_message_notifications':
          if (b.default_message_notifications !== undefined) {
            before = b.default_message_notifications === 0 ? 'すべてのメッセージ' : 'メンションのみ'
          }
          if (a.default_message_notifications !== undefined) {
            after = a.default_message_notifications === 0 ? 'すべてのメッセージ' : 'メンションのみ'
          }
          return {
            name: '通知設定',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'afk_channel_id': {
          const beforeChannel = b.afk_channel_id && newGuild.channels?.get?.(b.afk_channel_id)
          const afterChannel = a.afk_channel_id && newGuild.channels?.get?.(a.afk_channel_id)
          before = beforeChannel ? beforeChannel.name : 'なし'
          after = afterChannel ? afterChannel.name : 'なし'
          return {
            name: 'AFKチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        }
        case 'name':
          before = b.name ?? 'なし'
          after = a.name ?? 'なし'
          return {
            name: '名前',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'region':
          before = b.region || '自動'
          after = a.region || '自動'
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
            value: verificationLevels[a.verification_level] || '不明'
          }
        case 'mfa_level':
          before = b.mfa_level === 1 ? '有効' : '無効'
          after = a.mfa_level === 1 ? '有効' : '無効'
          return {
            name: '二要素認証レベル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'explicit_content_filter':
          before = explicitContentLevels[b.explicit_content_filter] || '不明'
          after = explicitContentLevels[a.explicit_content_filter] || '不明'
          return {
            name: '不適切なコンテンツフィルター',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'widget_enabled':
          before = b.widget_enabled ? '有効' : '無効'
          after = a.widget_enabled ? '有効' : '無効'
          return {
            name: 'ウィジェット',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'rules_channel_id':
          before = b.rules_channel_id ? global.bot.getChannel(b.rules_channel_id)?.name || 'なし' : 'なし'
          after = a.rules_channel_id ? global.bot.getChannel(a.rules_channel_id)?.name || 'なし' : 'なし'
          return {
            name: 'ルールチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'public_updates_channel_id':
          before = b.public_updates_channel_id ? global.bot.getChannel(b.public_updates_channel_id)?.name || 'なし' : 'なし'
          after = a.public_updates_channel_id ? global.bot.getChannel(a.public_updates_channel_id)?.name || 'なし' : 'なし'
          return {
            name: '公開アップデートチャンネル',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'preferred_locale':
          before = b.preferred_locale || '不明'
          after = a.preferred_locale || '不明'
          return {
            name: 'サーバーの言語',
            value: `► 変更後: **${after}**\n► 変更前: **${before}**`
          }
        case 'description':
          before = b.description || 'なし'
          after = a.description || 'なし'
          return {
            name: 'サーバーの説明',
            value: `► 変更後: **${escape(String(after))}**\n► 変更前: **${escape(String(before))}**`
          }
      }
    }
  }
}
