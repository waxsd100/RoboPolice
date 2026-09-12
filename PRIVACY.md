# Privacy Policy — ロボポリス (RoboPolice)

**Discord Application ID:** `308674858781245440`
**Effective date:** 2026-09-13
**Contact / Support server:** https://discord.com/invite/nobaman

*English text is authoritative for the purposes of Discord's review. 日本語訳は後半にあります。*

---

## 1. About this application

RoboPolice ("the App") is a **private** Discord application. It is not publicly listed, cannot be
added to servers by third parties, and operates in a **single Discord community** — the server
reachable at https://discord.com/invite/nobaman ("the Server"). The App is operated by that Server's
own staff, for that Server's own moderation.

The App reached Discord's 10,000-user threshold because the Server itself has more than 10,000
members, not because the App is distributed across many servers.

The App is a fork of the open-source Logger v3 project and is licensed AGPL-3.0-or-later. Its full
source code is public at https://github.com/waxsd100/RoboPolice — everything described in this policy
can be verified there.

## 2. What the App does

The App records moderation-relevant events in the Server and posts them to staff-only log channels:
member joins and leaves, kicks and bans, nickname and role changes, message deletions and edits,
channel/role/emoji/sticker/server-setting changes, invite usage, and voice channel activity. This
gives the Server's moderators a reviewable record of what happened.

## 3. What data we collect and store

The App only receives data from Discord's API, and only for the Server it is installed in.

### 3.1 Message data

For each message sent in a channel that has not been excluded from logging, the App stores one row:

| Field | Stored as |
|---|---|
| Message ID | plaintext |
| Author user ID | plaintext |
| Message content | **AES-256 encrypted** |
| Image attachment URLs (up to 10) | **AES-256 encrypted** |
| Timestamp | plaintext |

The App does **not** store the server ID or the channel ID of a message.

This exists for one purpose: so that when a message is later deleted or edited, the App can show
moderators what it previously said. Discord's API cannot return a deleted message, so holding it in
advance is the only way this feature can work.

### 3.2 Server configuration

Server ID, server owner ID, the log channel configured for each event type, the list of channels
excluded from logging, the list of disabled events, and per-server settings. This is configuration,
not personal data.

### 3.3 Temporary caches

Invite-code usage counters, webhook handles and server settings are held in Redis to avoid repeated
API calls. These are caches; they are not a long-term store and are cleared on restart.

### 3.4 What the App does NOT collect

- **Presence, online status or activity data.** The App does not use the Presence intent at all.
- **Member profile data.** Nicknames, roles and avatars are read live from Discord to render a log
  embed and are never written to our database.
- Direct messages — the App operates only in servers.
- Payment information, email addresses, IP addresses, or any data from outside Discord.

## 4. How we use the data

Solely to render the log embeds posted back into the Server the event came from, and to answer
moderator commands (`/userinfo`, `/serverinfo`, `/archive`).

We do **not** use any of this data for machine learning or AI model training, profiling, advertising,
analytics, or any statistical or commercial product. We do **not** sell, rent, or share it with third
parties. No data leaves the App's own infrastructure.

## 5. Retention

| Data | Retention |
|---|---|
| Message rows | **Up to 30 days**, then permanently deleted by an automated daily job |
| Server configuration | Until the App is removed from the Server |
| Temporary caches | Transient; cleared on restart |

The retention window is enforced in code by a scheduled deletion job
(`src/bot/modules/retention.js`), not manually.

## 6. Security

Message content and attachment URLs are encrypted with AES-256 in the application layer
(`src/db/aes.js`) **before** they are written to PostgreSQL, so plaintext message content never
reaches disk. The encryption key is held only in the App's runtime environment and is never stored in
the database. Database access is restricted to the App's own host.

## 7. Your choices

- **Server administrators** can exclude a channel from logging with `/ignorechannel`, disable logging
  entirely with `/stoplogging`, disable individual event types with `/setup`, and remove the App from
  the Server (which deletes its configuration).
- **Any member** can run `/clearmydata` to see how to request deletion of their stored data.

## 8. Requesting deletion of your data

Join https://discord.com/invite/nobaman and contact the staff with your Discord user ID. We will
delete the message rows stored for that user. Independently of any request, all message rows are
automatically deleted after 30 days.

## 9. Children

The App is not directed at anyone below the minimum age required by Discord's Terms of Service in
their country.

## 10. Changes to this policy

We may update this policy. The effective date above reflects the most recent revision, and the full
revision history is publicly visible in this file's git history at
https://github.com/waxsd100/RoboPolice/commits/master/PRIVACY.md. Material changes are announced in
the Server.

## 11. Contact

https://discord.com/invite/nobaman

---

# プライバシーポリシー — ロボポリス

**Discord アプリケーション ID:** `308674858781245440`
**発効日:** 2026-09-13
**連絡先／サポートサーバー:** https://discord.com/invite/nobaman

## 1. このアプリケーションについて

ロボポリス（以下「本BOT」）は**プライベート**な Discord アプリケーションです。一般公開されておらず、
第三者がサーバーに追加することはできません。稼働しているのは https://discord.com/invite/nobaman で
アクセスできる**単一のコミュニティサーバー**（以下「本サーバー」）のみであり、本サーバーの運営スタッフが
自サーバーのモデレーションのために運用しています。

本BOTが Discord の1万ユーザー基準に達したのは、本サーバー自体のメンバーが1万人を超えているためであり、
多数のサーバーに配布されているためではありません。

本BOTはオープンソースの Logger v3 のフォークで、AGPL-3.0-or-later でライセンスされています。
ソースコードは https://github.com/waxsd100/RoboPolice で公開されており、本ポリシーの記述はすべて
そこで検証できます。

## 2. 本BOTの機能

本サーバー内のモデレーション上重要なイベント（メンバーの参加・退出、キック、BAN、ニックネームおよび
ロールの変更、メッセージの削除・編集、チャンネル／ロール／絵文字／スタンプ／サーバー設定の変更、
招待の使用、ボイスチャンネルの入退室）を記録し、スタッフ専用のログチャンネルに投稿します。

## 3. 取得・保存するデータ

本BOTは Discord API から、設置されている本サーバーの分のみデータを受け取ります。

### 3.1 メッセージデータ

ログ対象から除外されていないチャンネルで送信された各メッセージについて、以下の1行を保存します。

| 項目 | 保存形式 |
|---|---|
| メッセージID | 平文 |
| 投稿者ユーザーID | 平文 |
| メッセージ本文 | **AES-256 で暗号化** |
| 画像添付のURL（最大10件） | **AES-256 で暗号化** |
| タイムスタンプ | 平文 |

メッセージのサーバーIDおよびチャンネルIDは保存していません。

これは「メッセージが後から削除・編集されたときに、モデレーターへ元の内容を表示する」という
唯一の目的のために存在します。削除済みメッセージは Discord API から取得できないため、
事前に保持する以外に方法がありません。

### 3.2 サーバー設定

サーバーID、サーバーオーナーID、イベント種別ごとのログチャンネル、ログ除外チャンネルの一覧、
無効化されたイベントの一覧、サーバーごとの設定。これらは設定情報であり個人データではありません。

### 3.3 一時キャッシュ

招待コードの使用回数、Webhook ハンドル、サーバー設定を Redis に保持します。これらはキャッシュであり
長期保存ではなく、再起動時に消去されます。

### 3.4 取得しないもの

- **プレゼンス（オンライン状態・アクティビティ）** — Presence インテントは一切使用していません。
- **メンバープロフィール** — ニックネーム・ロール・アバターはログ生成時に Discord から都度読み取るのみで、
  データベースには書き込みません。
- ダイレクトメッセージ（本BOTはサーバー内でのみ動作します）
- 決済情報、メールアドレス、IPアドレス、Discord 外部のあらゆるデータ

## 4. データの利用目的

イベントが発生した本サーバーへ投稿するログの生成、およびモデレーター向けコマンド
（`/userinfo`、`/serverinfo`、`/archive`）への応答のみに使用します。

機械学習・AIモデルの学習、プロファイリング、広告、分析、統計・商用目的には**一切使用しません**。
第三者への販売・貸与・共有も行いません。データが本BOTの自己インフラの外に出ることはありません。

## 5. 保持期間

| データ | 保持期間 |
|---|---|
| メッセージ行 | **最長30日**、その後は日次の自動ジョブで完全に削除 |
| サーバー設定 | 本BOTがサーバーから削除されるまで |
| 一時キャッシュ | 一時的（再起動時に消去） |

保持期間は手動ではなくコード上の自動削除ジョブ（`src/bot/modules/retention.js`）で強制されます。

## 6. セキュリティ

メッセージ本文と添付URLは、PostgreSQL に書き込まれる**前に**アプリケーション層（`src/db/aes.js`）で
AES-256 により暗号化されます。したがって平文のメッセージ本文がディスクに書かれることはありません。
暗号鍵は実行環境上にのみ存在し、データベースには保存されません。データベースへのアクセスは
本BOTのホストに限定されています。

## 7. 選択肢

- **サーバー管理者**は `/ignorechannel` でチャンネルをログ対象外にでき、`/stoplogging` でログを全停止でき、
  `/setup` でイベント種別ごとに無効化でき、本BOTをサーバーから削除できます（設定も削除されます）。
- **すべてのメンバー**は `/clearmydata` でデータ削除請求の方法を確認できます。

## 8. データ削除の請求

https://discord.com/invite/nobaman に参加し、ご自身の Discord ユーザーIDを添えてスタッフにご連絡ください。
当該ユーザーについて保存されているメッセージ行を削除します。請求の有無にかかわらず、
メッセージ行は30日で自動的に削除されます。

## 9. 年齢

本BOTは、各国の Discord 利用規約が定める最低年齢に満たない方を対象としていません。

## 10. 本ポリシーの変更

本ポリシーは改定されることがあります。冒頭の発効日が最新の改定を示し、改定履歴は
https://github.com/waxsd100/RoboPolice/commits/master/PRIVACY.md で公開されています。
重要な変更は本サーバー内で告知します。

## 11. 連絡先

https://discord.com/invite/nobaman
