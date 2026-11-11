const Eris = require('eris')
const { EMBED_COLORS } = require('../utils/constants.js')
const { getEmbedFooter } = require('../utils/embeds')
const { pick } = require('../utils/i18n')

// Permission presets:
// - recommended (318364830896): logging + auto #robopolice-logs + invite tracking + file attachments + Manage Events + public threads/forums
// - tracking    (537218224):    logging + Manage Channels + Manage Server (invite tracking)
// - basic       (537218176):    basic audit logging only (manual /setup)
const PERM_BASIC = '537218176'
const PERM_TRACKING = '537218224'
const PERM_RECOMMENDED = '318364830896'

module.exports = {
  name: 'invite',
  func: async interaction => {
    const id = global.bot.user.id
    const recommended = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=${PERM_RECOMMENDED}`
    const tracking = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=${PERM_TRACKING}`
    const basic = `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot+applications.commands&permissions=${PERM_BASIC}`
    return interaction.createMessage({
      embeds: [{
        title: pick(interaction, { ja: '招待リンク', en: 'Invite links' }),
        description: pick(interaction, {
          ja: '用途別の招待リンクです。迷った場合は一番上の **推奨（すべての機能）** を選べば、招待直後から自動ログ設定・招待追跡・AIによるイベント＆フォーラム作成まですべて使えます。\n\n招待後の確認は `/setup status`、詳しい手順は `/help guide: 使い方・初期設定` をご覧ください。',
          en: 'Invite links by use case. Choose **Recommended (all features)** to have automatic log setup, invite tracking, and AI event & forum creation ready right away.\n\nRun `/setup status` after inviting to verify everything.'
        }),
        color: EMBED_COLORS.PURPLED_BLUE,
        thumbnail: {
          url: interaction.member.user.dynamicAvatarURL(null, 64)
        },
        fields: [
          {
            name: pick(interaction, { ja: '⭐ 推奨：すべての機能（自動ログ・招待追跡・イベント＆フォーラム作成）', en: '⭐ Recommended: All features (auto-log, invite tracking, events & forums)' }),
            value: pick(interaction, {
              ja: `[この招待リンク](${recommended}) から、スタッフ用ログチャンネル（\`#robopolice-logs\`）の自動作成、参加時の招待リンク追跡、カバー画像添付、\`@メンション\` でのイベント・フォーラム投稿作成、YouTube配信の自動イベント登録に必要な権限をまとめて付与できます。`,
              en: `[This invite link](${recommended}) includes permissions for automatic \`#robopolice-logs\` setup, join-invite tracking, cover image attachments, \`@mention\` event & forum creation, and automatic YouTube stream events.`
            })
          },
          {
            name: pick(interaction, { ja: '📋 監査ログ＋招待トラッキング用（サーバーの管理・チャンネルの管理を含む）', en: '📋 Audit logs + invite tracking (Manage Server & Manage Channels)' }),
            value: pick(interaction, {
              ja: `[この招待リンク](${tracking}) は監査ログと参加時の招待リンク記録用の構成です（イベント自動作成は使いません）。`,
              en: `[This invite link](${tracking}) includes audit logging and join-invite tracking without event management.`
            })
          },
          {
            name: pick(interaction, { ja: '🔒 最小権限（基本ログのみ・手動セットアップ）', en: '🔒 Minimal permissions (basic logs only, manual /setup)' }),
            value: pick(interaction, {
              ja: `[この招待リンク](${basic}) から必要最小限の権限だけで招待できます（招待後にログ用チャンネルで \`/setup status\` を実行してください）。`,
              en: `[This invite link](${basic}) grants only the minimum logging permissions (run \`/setup status\` in your log channel afterwards).`
            })
          }
        ],
        footer: getEmbedFooter(global.bot.user)
      }],
      components: [{
        type: Eris.Constants.ComponentTypes.ACTION_ROW,
        components: [
          {
            type: Eris.Constants.ComponentTypes.BUTTON,
            style: Eris.Constants.ButtonStyles.LINK,
            url: recommended,
            label: pick(interaction, { ja: '推奨（すべての機能）', en: 'Recommended (All)' })
          },
          {
            type: Eris.Constants.ComponentTypes.BUTTON,
            style: Eris.Constants.ButtonStyles.LINK,
            url: tracking,
            label: pick(interaction, { ja: 'ログ＋招待追跡', en: 'Logs + Invites' })
          },
          {
            type: Eris.Constants.ComponentTypes.BUTTON,
            style: Eris.Constants.ButtonStyles.LINK,
            url: basic,
            label: pick(interaction, { ja: '最小権限', en: 'Minimal' })
          }
        ]
      }],
      flags: Eris.Constants.MessageFlags.EPHEMERAL
    })
  }
}
