exports.ALL_EVENTS = [
  'channelCreate',
  'channelUpdate',
  'channelDelete',
  'guildBanAdd',
  'guildBanRemove',
  'guildRoleCreate',
  'guildRoleDelete',
  'guildRoleUpdate',
  'guildUpdate',
  'messageDelete',
  'messageDeleteBulk',
  'messageUpdate',
  'guildMemberAdd',
  'guildMemberKick',
  'guildMemberRemove',
  'guildMemberUpdate',
  'guildMemberNickUpdate',
  'guildMemberVerify',
  'voiceChannelLeave',
  'voiceChannelJoin',
  'voiceStateUpdate',
  'voiceChannelSwitch',
  'guildEmojisUpdate',
  'guildStickersUpdate',
  'guildMemberBoostUpdate',
  'presenceUpdate'
]

exports.EVENT_HELP = {
  channelCreate: 'テキスト／ボイス／アナウンス／カテゴリ／ステージの各チャンネルが作成されたときに記録します。権限の上書きと、作成したユーザーも含まれます。',
  channelUpdate: 'テキスト／ボイス／アナウンス／カテゴリ／ステージの各チャンネルが更新されたときに記録します。権限の上書きの作成・変更・削除、ビットレート、低速モード、トピックの変更が対象です。更新したユーザーと理由（あれば）も含まれます。',
  channelDelete: 'テキスト／ボイス／アナウンス／カテゴリ／ステージの各チャンネルが削除されたときに記録します。権限の上書き、削除したユーザー、理由（あれば）も含まれます。',
  guildBanAdd: 'メンバーがサーバーからBANされたときに記録します。実行者と理由（あれば）も含まれます。',
  guildBanRemove: 'メンバーのBANが解除されたときに記録します。実行者と理由（あれば）も含まれます。',
  guildRoleCreate: 'ロールが作成されたときに記録します。作成者、名前、色、メンション可否、他と分けて表示、権限が含まれます。',
  guildRoleDelete: 'ロールが削除されたときに記録します。削除者、名前、色、メンション可否、他と分けて表示、権限が含まれます。',
  guildRoleUpdate: 'ロールの設定が変更されたときに記録します。変更者、名前、アイコン、色、メンション可否、他と分けて表示、権限の変更が含まれます。',
  guildUpdate: 'サーバーの設定が変更されたときに記録します。対象は不適切なコンテンツフィルター、NSFWレベル、AFK設定、バナー、通知レベル、説明、アイコン、二要素認証、言語、ルールチャンネル、公式メッセージチャンネル、カスタムURLです。変更したユーザーも含まれます。',
  messageDelete: 'メンバーが自分のメッセージを削除したとき、またはBOTがメッセージを削除したときに記録します。既定ではBOTのメッセージの削除はスパム防止のため記録しません（`/logbots` で有効化できます）。削除を実行したユーザーは含まれません（グローバルレート制限を避けるため取得していません）。',
  messageDeleteBulk: 'BOTがメッセージを一括削除したとき、またはメンバーのBANに伴ってメッセージが削除されたときに記録します。内容が判明している場合はアーカイブにまとめ、閲覧用のリンクを含めます。',
  messageUpdate: 'メンバーが自分のメッセージを編集したときに記録します。編集されたメッセージへのジャンプリンクを含みます。BOTによる編集は記録しません（スパム防止）。',
  guildMemberAdd: 'ユーザーがサーバーに参加したときに記録します。アカウントの作成日時、使用された招待、サーバーのメンバー数を含みます。',
  guildMemberKick: 'メンバーがサーバーからキックされたときに記録します。実行したユーザーと理由（あれば）を含みます。',
  guildMemberRemove: 'メンバーがサーバーから退出したときに記録します。退出がキックによるものだった場合は、この代わりに guildMemberKick が記録されます。',
  guildMemberUpdate: 'メンバーのロールが付与・剥奪されたとき、またはタイムアウトされたときに記録します。実行したユーザーと理由（あれば）を含みます。',
  guildMemberNickUpdate: 'メンバーがニックネームを変更した、または変更されたときに記録します。注意: すべてのニックネーム変更が記録されるわけではなく、BOTが先に把握しているメンバー（発言を確認済みのメンバー）に限られます。',
  guildMemberVerify: 'メンバーがサーバーのメンバーシップ審査（ルール同意）を承諾したときに記録します。',
  voiceChannelLeave: 'メンバーがボイスチャンネルから退出したときに記録します。強制切断を実行したメンバーがいた場合でも、その実行者は含まれません。',
  voiceChannelJoin: 'メンバーがボイスチャンネルに参加したときに記録します。',
  voiceStateUpdate: 'メンバーがボイスチャンネルでサーバーミュートまたはスピーカーミュートされたときに記録します。実行したユーザーを含みます。',
  voiceChannelSwitch: 'メンバーがボイスチャンネルを移動したときに記録します。強制的に移動させたメンバーがいた場合でも、その実行者は含まれません。',
  guildEmojisUpdate: '絵文字が追加・更新・削除されたときに記録します。対象の絵文字と、実行したユーザーを含みます。',
  guildMemberBoostUpdate: 'メンバーがサーバーブーストを開始または終了したときに記録します。',
  guildStickersUpdate: 'スタンプが追加・更新・削除されたときに記録します。対象のスタンプと、実行したユーザーを含みます。',
  presenceUpdate: 'メンバーがカスタムステータスを変更した際に記録します。禁止ワードや不適切なリンクの監視に有用です。'
}

exports.EVENTS_USING_AUDITLOGS = [
  'channelCreate',
  'channelUpdate',
  'channelDelete',
  'guildBanAdd',
  'guildBanRemove',
  'guildRoleCreate',
  'guildRoleDelete',
  'guildRoleUpdate',
  'guildUpdate',
  'messageDeleteBulk',
  'guildMemberKick',
  'guildMemberRemove',
  'guildMemberUpdate',
  'voiceStateUpdate',
  'guildEmojisUpdate',
  'guildStickersUpdate'
]

exports.EMBED_COLORS = {
  RED: 0xbb2124,
  YELLOW_ORANGE: 0xffaf24,
  GREEN: 0x22bb33,
  PURPLED_BLUE: 0x3838fc,
  CLEAR: 0x36393f // clear for dark mode users
}

exports.PRESET_EVENT_MAP = {
  voice: ['voiceChannelLeave', 'voiceChannelJoin', 'voiceChannelSwitch', 'voiceStateUpdate'],
  message: ['messageUpdate', 'messageDelete', 'messageDeleteBulk'],
  member: ['guildMemberUpdate', 'guildMemberNickUpdate', 'guildMemberVerify', 'guildMemberBoostUpdate', 'presenceUpdate'],
  moderation: ['guildBanAdd', 'guildBanRemove', 'guildMemberKick'],
  joinlog: ['guildMemberAdd', 'guildMemberRemove'],
  server: ['guildUpdate'],
  role: ['guildRoleUpdate', 'guildRoleCreate', 'guildRoleDelete'],
  channel: ['channelCreate', 'channelUpdate', 'channelDelete'],
  all: this.ALL_EVENTS
}

// Public legal documents. These URLs are what is registered with Discord (Developer Portal and the
// privileged intent review), so they must stay resolvable. Override per-deployment if self-hosting.
exports.LEGAL_LINKS = {
  PRIVACY_POLICY: process.env.PRIVACY_POLICY_URL || 'https://github.com/waxsd100/RoboPolice/wiki/Privacy-Policy',
  TERMS_OF_SERVICE: process.env.TERMS_OF_SERVICE_URL || 'https://github.com/waxsd100/RoboPolice/wiki/Terms-of-Service'
}
