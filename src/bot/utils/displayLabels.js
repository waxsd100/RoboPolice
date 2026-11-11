// Human-readable Japanese and English names for Discord permission keys and audit log events,
// used in /setup, /stoplogging, permission error embeds and onboarding diagnostics.
const PERMISSION_LABELS = {
  ja: {
    administrator: '管理者',
    manageGuild: 'サーバーの管理',
    manageRoles: 'ロールの管理',
    manageChannels: 'チャンネルの管理',
    manageWebhooks: 'ウェブフックの管理',
    manageEvents: 'イベントの管理',
    manageThreads: 'スレッドの管理',
    manageMessages: 'メッセージの管理',
    manageNicknames: 'ニックネームの管理',
    manageEmojis: '絵文字・スタンプの管理',
    manageEmojisAndStickers: '絵文字・スタンプの管理',
    viewAuditLog: '監査ログの表示',
    viewAuditLogs: '監査ログの表示',
    viewChannel: 'チャンネルを見る',
    readMessages: 'チャンネルを見る',
    sendMessages: 'メッセージを送信',
    sendMessagesInThreads: 'スレッドでメッセージを送信',
    createPublicThreads: '公開スレッドの作成',
    createPrivateThreads: 'プライベートスレッドの作成',
    embedLinks: '埋め込みリンク',
    attachFiles: 'ファイルを添付',
    readMessageHistory: 'メッセージ履歴を読む',
    useExternalEmojis: '外部の絵文字を使用する',
    externalEmojis: '外部の絵文字を使用する',
    kickMembers: 'メンバーをキック',
    banMembers: 'メンバーをBAN',
    moderateMembers: 'メンバーをタイムアウト'
  },
  en: {
    administrator: 'Administrator',
    manageGuild: 'Manage Server',
    manageRoles: 'Manage Roles',
    manageChannels: 'Manage Channels',
    manageWebhooks: 'Manage Webhooks',
    manageEvents: 'Manage Events',
    manageThreads: 'Manage Threads',
    manageMessages: 'Manage Messages',
    manageNicknames: 'Manage Nicknames',
    manageEmojis: 'Manage Expressions',
    manageEmojisAndStickers: 'Manage Expressions',
    viewAuditLog: 'View Audit Log',
    viewAuditLogs: 'View Audit Log',
    viewChannel: 'View Channels',
    readMessages: 'View Channels',
    sendMessages: 'Send Messages',
    sendMessagesInThreads: 'Send Messages in Threads',
    createPublicThreads: 'Create Public Threads',
    createPrivateThreads: 'Create Private Threads',
    embedLinks: 'Embed Links',
    attachFiles: 'Attach Files',
    readMessageHistory: 'Read Message History',
    useExternalEmojis: 'Use External Emojis',
    externalEmojis: 'Use External Emojis',
    kickMembers: 'Kick Members',
    banMembers: 'Ban Members',
    moderateMembers: 'Timeout Members'
  }
}

const EVENT_LABELS = {
  ja: {
    channelCreate: 'チャンネル作成',
    channelUpdate: 'チャンネル更新',
    channelDelete: 'チャンネル削除',
    guildBanAdd: 'メンバーBAN',
    guildBanRemove: 'メンバーBAN解除',
    guildRoleCreate: 'ロール作成',
    guildRoleDelete: 'ロール削除',
    guildRoleUpdate: 'ロール更新',
    guildUpdate: 'サーバー設定変更',
    messageDelete: 'メッセージ削除',
    messageDeleteBulk: 'メッセージ一括削除',
    messageUpdate: 'メッセージ編集',
    guildMemberAdd: 'メンバー参加',
    guildMemberKick: 'メンバーキック',
    guildMemberRemove: 'メンバー退出',
    guildMemberUpdate: 'ロール付与・剥奪／タイムアウト',
    guildMemberNickUpdate: 'ニックネーム変更',
    guildMemberVerify: 'メンバー認証通過',
    voiceChannelLeave: 'ボイス退出',
    voiceChannelJoin: 'ボイス参加',
    voiceStateUpdate: 'ボイスミュート',
    voiceChannelSwitch: 'ボイス移動',
    guildEmojisUpdate: '絵文字変更',
    guildStickersUpdate: 'スタンプ変更',
    guildMemberBoostUpdate: 'サーバーブースト変更',
    presenceUpdate: 'カスタムステータス変更'
  },
  en: {
    channelCreate: 'Channel Create',
    channelUpdate: 'Channel Update',
    channelDelete: 'Channel Delete',
    guildBanAdd: 'Member Banned',
    guildBanRemove: 'Member Unbanned',
    guildRoleCreate: 'Role Create',
    guildRoleDelete: 'Role Delete',
    guildRoleUpdate: 'Role Update',
    guildUpdate: 'Server Settings Change',
    messageDelete: 'Message Delete',
    messageDeleteBulk: 'Bulk Message Delete',
    messageUpdate: 'Message Edit',
    guildMemberAdd: 'Member Join',
    guildMemberKick: 'Member Kick',
    guildMemberRemove: 'Member Leave',
    guildMemberUpdate: 'Role / Timeout Update',
    guildMemberNickUpdate: 'Nickname Update',
    guildMemberVerify: 'Membership Screening',
    voiceChannelLeave: 'Voice Leave',
    voiceChannelJoin: 'Voice Join',
    voiceStateUpdate: 'Voice Mute/Deafen',
    voiceChannelSwitch: 'Voice Move',
    guildEmojisUpdate: 'Emojis Change',
    guildStickersUpdate: 'Stickers Change',
    guildMemberBoostUpdate: 'Server Boost Update',
    presenceUpdate: 'Custom Status Update'
  }
}

function formatPermission (perm, lang = 'ja') {
  const table = PERMISSION_LABELS[lang] || PERMISSION_LABELS.ja
  return table[perm] || perm
}

function formatPermissions (perms, lang = 'ja') {
  return (perms || []).map(p => `**${formatPermission(p, lang)}**`).join(lang === 'en' ? ', ' : '・')
}

function formatEventName (eventName, lang = 'ja') {
  const table = EVENT_LABELS[lang] || EVENT_LABELS.ja
  return table[eventName] || eventName
}

module.exports = {
  PERMISSION_LABELS,
  EVENT_LABELS,
  formatPermission,
  formatPermissions,
  formatEventName
}
