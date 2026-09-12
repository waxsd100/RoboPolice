# Privacy Policy — ロボポリス (RoboPolice)

**Discord Application ID:** `308674858781245440`
**Effective date:** 2026-09-13
**Contact / Support server:** https://discord.com/invite/nobaman

*English text is authoritative for the purposes of Discord's review. 日本語訳は後半にあります。*

---

## 1. About this application

RoboPolice ("the App") is a **private** Discord application. It is not publicly listed and cannot be
added to servers by third parties. It runs in a small number of servers, all of them ours:

- the community server reachable at https://discord.com/invite/nobaman ("the Server"), the only
  place it actually logs anything, and
- a few private test servers we operate, used to try changes before they reach the Server. No
  logging is configured there, and the App stores no message content for a server that has no
  delete/edit log channel set up (see section 3.1).

Everything in this policy applies to all of them; "the Server" below covers each server the App is
installed in.

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

The App stores message rows only for a server that has a message deletion or edit log channel
configured; in a server with none, nothing is stored. Where logging is configured, for each message
sent in a channel that has not been excluded, the App stores one row:

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
API calls. These are caches: every key carries a 3-hour expiry and they are cleared on restart.

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
analytics, or any statistical or commercial product. We do **not** sell or rent it to anyone.

Two components can send data outside our own servers:

- **Error monitoring.** When the App hits an unexpected error, the error and its stack trace are sent
  to Sentry so we can fix it. Error reports are not intended to contain message content, but we
  cannot guarantee that a stack trace never includes a fragment of it.
- **Message archives.** `/archive` (run by a moderator with Manage Messages) and bulk-deletion logs
  write the affected messages to a paste service so the log can link to them instead of flooding the
  channel. Anyone holding the resulting link can read that archive. The paste service is configured
  by the operator; see section 11 to ask which instance is in use.

Apart from these, data stays on infrastructure we operate.

## 5. Retention

| Data | Retention |
|---|---|
| Message rows | **30 days**, then permanently deleted |
| Server configuration | Until the App is removed from the Server |
| Temporary caches | 3-hour expiry; also cleared on restart |

Message rows are deleted once they are 30 days old. This is enforced by a scheduled job
(`src/miscellaneous/prune.js`) that runs automatically, not by hand. A row is also dropped earlier if
its message is deleted and that single deletion is logged, because the log embed then holds the
record; this does not apply to bulk deletions, whose rows wait for the 30-day sweep.

Two limits are worth stating plainly:

- Excluding a channel with `/ignorechannel` stops future logging in it. It does not immediately
  remove rows already stored from that channel; those expire on the normal 30-day schedule.
- Because we do not store a server or channel ID alongside a message (section 3.1), we cannot select
  rows by server. Rows can be selected by user ID, which is what a deletion request uses.

If we change the retention window, this section will be updated before the change takes effect.

## 6. Security

Message content and attachment URLs are encrypted with AES-256 in the application layer
(`src/db/aes.js`) **before** they are written to PostgreSQL, so plaintext message content never
reaches disk. The encryption key is held only in the App's runtime environment and is never stored in
the database.

## 7. Your choices

- **Server administrators** can exclude a channel from logging with `/ignorechannel`, disable logging
  entirely with `/stoplogging`, disable individual event types with `/setup`, and remove the App from
  the Server (which deletes its configuration).
- **Any member** can run `/clearmydata` to see how to request deletion of their stored data.

## 8. Requesting deletion of your data

Join https://discord.com/invite/nobaman and contact the staff with your Discord user ID. We will
delete the message rows stored for that user. Independently of any request, all message rows are
deleted after 30 days.

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
第三者がサーバーに追加することはできません。設置されているのは当方が運営する少数のサーバーのみです。

- https://discord.com/invite/nobaman でアクセスできるコミュニティサーバー（以下「本サーバー」）。
  実際にログを取得しているのはここだけです。
- 当方が運営する少数の非公開テストサーバー。本サーバーへ反映する前の動作確認に使用します。
  ログの出力先を設定していないため、メッセージの保存も行われません（本BOTは、削除・編集ログの
  出力先が設定されていないサーバーではメッセージを保存しません。3.1 参照）。

本ポリシーはそのすべてに適用されます。以下の「本サーバー」は、本BOTが設置されている各サーバーを指します。

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

メッセージの保存を行うのは、メッセージの削除・編集ログの出力先が設定されているサーバーだけです。
設定が無いサーバーでは一切保存しません。設定があるサーバーでは、ログ対象から除外されていない
チャンネルで送信された各メッセージについて、以下の1行を保存します。

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

招待コードの使用回数、Webhook ハンドル、サーバー設定を Redis に保持します。これらはキャッシュであり、
すべてのキーに3時間の有効期限が設定されているほか、再起動時にも消去されます。

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
第三者への販売・貸与も行いません。

ただし、以下の2つの機能はデータを当方のサーバー外へ送信します。

- **エラー監視** — 予期しないエラーが発生した場合、修正のためエラー内容とスタックトレースを Sentry へ
  送信します。エラー報告にメッセージ本文を含める意図はありませんが、スタックトレースに断片が
  混入しない保証まではできません。
- **メッセージのアーカイブ** — `/archive`（メッセージ管理権限を持つモデレーターが実行）および
  一括削除ログは、対象メッセージを paste サービスへ書き出し、ログからリンクします。そのリンクを
  知る者は誰でもアーカイブを閲覧できます。使用する paste サービスは運用者が設定します。
  どのインスタンスを使用しているかは第11項の連絡先までお問い合わせください。

これら以外については、データが当方の運用するインフラの外に出ることはありません。

## 5. 保持期間

| データ | 保持期間 |
|---|---|
| メッセージ行 | **30日**、その後は完全に削除 |
| サーバー設定 | 本BOTがサーバーから削除されるまで |
| 一時キャッシュ | 3時間で失効（再起動時にも消去） |

メッセージ行は30日経過した時点で削除されます。これは手動ではなく、定期実行されるジョブ
（`src/miscellaneous/prune.js`）によって強制されます。また単一のメッセージが削除され、その削除が
ログに出力された時点で該当行はより早く削除されます（ログがその役割を引き継ぐため）。ただし
**一括削除**（BANに伴う削除など）にはこの早期削除は適用されず、通常の30日で削除されます。

以下の2点は明示しておきます。

- `/ignorechannel` によるチャンネルの除外は、以後のログ取得を停止するものです。そのチャンネルから
  既に保存された行が即座に消えるわけではなく、通常どおり30日で削除されます。
- メッセージにサーバーIDやチャンネルIDを併せて保存していないため（3.1）、サーバー単位で行を
  選択することはできません。ユーザーID単位での選択は可能で、削除請求はこれを用います。

保持期間を変更する場合は、適用前に本項を更新します。

## 6. セキュリティ

メッセージ本文と添付URLは、PostgreSQL に書き込まれる**前に**アプリケーション層（`src/db/aes.js`）で
AES-256 により暗号化されます。したがって平文のメッセージ本文がディスクに書かれることはありません。
暗号鍵は実行環境上にのみ存在し、データベースには保存されません。

## 7. 選択肢

- **サーバー管理者**は `/ignorechannel` でチャンネルをログ対象外にでき、`/stoplogging` でログを全停止でき、
  `/setup` でイベント種別ごとに無効化でき、本BOTをサーバーから削除できます（設定も削除されます）。
- **すべてのメンバー**は `/clearmydata` でデータ削除請求の方法を確認できます。

## 8. データ削除の請求

https://discord.com/invite/nobaman に参加し、ご自身の Discord ユーザーIDを添えてスタッフにご連絡ください。
当該ユーザーについて保存されているメッセージ行を削除します。請求の有無にかかわらず、
メッセージ行は30日で削除されます。

## 9. 年齢

本BOTは、各国の Discord 利用規約が定める最低年齢に満たない方を対象としていません。

## 10. 本ポリシーの変更

本ポリシーは改定されることがあります。冒頭の発効日が最新の改定を示し、改定履歴は
https://github.com/waxsd100/RoboPolice/commits/master/PRIVACY.md で公開されています。
重要な変更は本サーバー内で告知します。

## 11. 連絡先

https://discord.com/invite/nobaman
