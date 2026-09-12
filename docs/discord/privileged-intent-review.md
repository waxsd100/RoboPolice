# Discord 特権インテント審査 申請パック（ロボポリス）

Discord から「10,000ユーザー到達につき特権インテントの審査申請が必要」という通知が届いたための申請資料です。
残り猶予は通知時点で **29日**。Developer Portal → 該当アプリ → **Bot** タブ → *Privileged Gateway Intents* セクションの
**Apply for Access** ボタンから申請します。

| 項目 | 値 |
|---|---|
| アプリ名 | ロボポリス (RoboPolice) |
| アプリケーション ID | `308674858781245440` |
| ベース | Logger v3 (AGPL-3.0) のフォーク |
| ソース | https://github.com/waxsd100/RoboPolice |

---

## 1. 結論：申請すべきインテントは何か

コードを実地調査した結果です。**使っていないインテントを申請に含めると、申請全体が却下されます**
（Discord は部分承認をせず、1つでも不要と判断されると全体が Denied になります）。

| 特権インテント | 実際の使用 | 申請 | 根拠 |
|---|---|---|---|
| **Server Members** (`GUILD_MEMBERS`) | **使用中** | **申請する** | `src/bot/index.js:65` で有効化。参加/退出/キック/ニックネーム/ロール変更ログの根幹 |
| **Message Content** (`MESSAGE_CONTENT`) | **使用中**（実機確認済み） | **申請する** | 削除/編集メッセージの本文ログに必須。詳細は 1.1 |
| **Presence** (`GUILD_PRESENCES`) | **未使用** | **申請しない** | コード全体で `guildPresences` の参照ゼロ |

### 1.1 Message Content は本番で動作している（実機確認済み）

削除ログに実際のメッセージ本文が出力されることを確認済みのため、**本番のロボポリスは
ゲートウェイで MESSAGE_CONTENT (`1 << 15`) を要求できています**。したがって Message Content は
「実使用中の特権インテント」であり、申請対象で確定です。

一方で、**このリポジトリの内容そのままでは Message Content を要求できません**（申請とは別件の乖離）：

- `src/bot/index.js:60-68` の intents 配列に `messageContent` が無い
- `package-lock.json` が固定している Eris は `curtisf/eris` の commit `c075c5b`（`0.16.2-dev`）で、
  この版の `lib/Constants.js` の `Intents` は `directMessageTyping` (`1 << 14`) で終わっており、
  `messageContent` の定数が存在しない
- `lib/Client.js:176-188` は配列を走査して未知の名前を `warn` して**黙って捨てる**実装のため、
  仮に `'messageContent'` を配列に足しても無視される

この状態で計算されるビットフィールドは `719`（`messageContent` の `32768` を含まない）です。
実機が動いている以上、**本番環境は別バージョンの Eris か、別の intents 指定で稼働しています。**

> **申請への影響：なし。** Message Content を申請対象に含めてください。
> ただし「リポジトリの `master` と本番デプロイが乖離している」こと自体は別途確認を推奨します
> （このリポジトリから `npm ci` で再デプロイすると本文ログが壊れます）。

---

## 2. 各インテントの使用箇所（審査で問われる根拠）

### Server Members Intent

| 機能 | ファイル |
|---|---|
| 参加ログ（アカウント作成日・使用された招待コードの特定） | `src/bot/events/guildMemberAdd.js` |
| 退出／キックログ（Audit Log 照合で退出とキックを判別、所持ロールを記録） | `src/bot/events/guildMemberRemove.js:28-31` |
| ニックネーム変更・ロール変更・メンバー認証通過ログ | `src/bot/events/guildMemberUpdate.js` |
| 他の全ログ埋め込みでの表示名／ニックネーム／アバター解決 | `src/bot/events/messageDelete.js:19-31`, `messageUpdate.js:16` |
| `/userinfo` コマンド | `src/bot/slashcommands/userinfo.js` |
| BAN / BAN解除ログの対象者情報 | `src/bot/events/guildBanAdd.js`, `guildBanRemove.js` |

**代替不可の理由**：`GUILD_MEMBER_ADD` / `REMOVE` / `UPDATE` は特権インテント無しでは一切届きません。
スラッシュコマンドは「ユーザーが実行したとき」しか動かないため、参加・退出という*受動的イベント*の記録には原理的に使えません。

### Message Content Intent

| 機能 | ファイル |
|---|---|
| メッセージをAES-256暗号化してDBへ保存（削除時ログの元データ） | `src/db/interfaces/postgres/create.js:42-64` |
| 削除メッセージの本文表示 | `src/bot/events/messageDelete.js:44-60` |
| 編集の Before / After 差分表示 | `src/bot/events/messageUpdate.js:60-110` |
| 一括削除ログ | `src/bot/events/messageDeleteBulk.js` |
| `/archive`（モデレーターによるチャンネル書き出し） | `src/bot/slashcommands/archive.js:36` |

**代替不可の理由**：削除されたメッセージは Discord API から再取得できません。
モデレーターが荒らし・詐欺リンク・ハラスメントに対処するには、削除される*前*に本文を保持している必要があり、
これはスラッシュコマンドでは実現できません。

---

## 3. 申請フォーム 回答テンプレート（英語・そのまま貼り付け可）

> フォームの自由記述欄は **1項目あたり2,000文字上限**です。以下はすべて上限内に収めてあります。
> `<< >>` で囲った箇所は送信前に必ず実値へ置き換えてください。

### Q. What does your application do?

```
RoboPolice (ロボポリス) is a server audit-logging app used mainly by Japanese-speaking Discord
communities. Server administrators use /setup to bind each event type to a log channel. The app then
posts a structured embed to that channel whenever a moderation-relevant event occurs, giving staff a
permanent, reviewable record of what happened in their server.

Logged events include: member joins (with account age and which invite code was used), member leaves,
kicks and bans, nickname changes, role changes, membership-screening completions, message deletions,
message edits (before/after), bulk deletions, channel/role/emoji/sticker/server-setting changes,
invite creation and deletion, and voice channel join/leave/move.

Moderators also have slash commands: /setup, /ignorechannel (exclude a channel from logging),
/stoplogging (disable logging entirely), /logbots (toggle logging of bot messages), /userinfo,
/serverinfo, /archive (export recent messages of a channel for an investigation), and /clearmydata.

The app is a fork of the open-source Logger v3 project (AGPL-3.0). Source code:
https://github.com/waxsd100/RoboPolice

The app does not use the Presence intent and is not applying for it.
```

### Q. Do you have a public Privacy Policy telling your users about their data usage?

```
Yes.
```

### Q. Where is your Privacy Policy available? / Please share a link to your Privacy Policy.

```
<< https://.../privacy の安定した恒久URL >>
```

> ⚠️ **最頻出の却下理由がここです。** Discord サーバーの招待リンクや Discord 自体のポリシーページは不可。
> 「stable, permanent URL」で自前ホストしている必要があります。
> 雛形を `docs/discord/PRIVACY_POLICY.md` に用意しました（§4 参照）。

### Q. Which intents are you applying for?

```
Server Members Intent, Message Content Intent
(Presence Intent is NOT requested — the app does not use it.)
```

### Q. Why do you need the Guild Members (Server Members) intent?

```
Member lifecycle logging is the single most used feature of this app, and it is impossible without
this intent because GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE / GUILD_MEMBER_UPDATE are simply not
delivered without it. These are passive server events, so slash commands cannot substitute for them:
there is no user interaction to hang a command off when someone quietly leaves a server.

Concretely, the intent powers:

1. Join logs — we report the joining member, their account creation age (a standard raid/alt-account
   signal for moderators), the server member count, and which invite code was used. Invite attribution
   is done by diffing the guild's invite uses against our cache on each GUILD_MEMBER_ADD.
2. Leave and kick logs — on GUILD_MEMBER_REMOVE we read the audit log to distinguish a voluntary
   leave from a kick, name the responsible moderator, and record the roles the member held at the
   time so staff can see what access was lost.
3. Nickname, role and membership-screening logs — from GUILD_MEMBER_UPDATE, so staff can see who
   gained a privileged role and when.
4. Member resolution for every other log embed — the member object (nickname, roles, avatar) is what
   lets a deletion or ban log say "Taro (nickname: Mod-Taro)" instead of a bare snowflake ID.
5. The /userinfo moderation command.

We only read member data; we never store member profile data in our database. Member objects live in
the gateway cache in memory and are discarded when the process restarts.
```

### Q. Why do you need the Message Content intent?

```
The core feature of the app is telling moderators what a deleted or edited message actually said.
Once a message is deleted, it can never be retrieved from the Discord API again, so the only way to
provide this is to have received the content before the deletion happened. No slash-command or
interaction-based design can replace this — by the time a moderator could run a command, the evidence
is already gone.

Message Content is used for exactly these features:

1. Message deletion logs — the text and image attachments of the removed message are shown to staff.
   This is what communities use to act on scam/phishing links, raid spam, doxxing and harassment,
   and to review whether another moderator's deletion was appropriate.
2. Message edit logs — a before/after diff, used to catch "post a normal message, then edit it into
   an advertisement or a scam link" behaviour, which is invisible in Discord's own UI.
3. Bulk deletion logs — the same, for mass deletions.
4. /archive — lets a moderator with Manage Messages export recent messages of one channel for an
   incident report.

We do NOT use message content for machine learning, model training, statistics, profiling,
advertising or any analytics, and we never share it with third parties. It is used solely to render
the log embed that is sent back into the same server the message came from.

Content is AES-256 encrypted before it is written to our database, and rows are purged after
<< MESSAGE_HISTORY_DAYS >> days. Server administrators can exclude channels with /ignorechannel or
turn logging off entirely with /stoplogging.
```

### Q. Please provide links to screenshots and/or videos that demonstrate your use case

```
<< 下記 §4 のチェックリストに沿って撮影し、恒久URLを貼る >>
```

### Q. Are you storing any API Data off-platform?

```
Yes. We store the minimum required to render deletion/edit logs.

PostgreSQL "messages" table, one row per message seen:
  - message ID
  - author ID
  - message content, AES-256 encrypted
  - attachment image URLs, AES-256 encrypted
  - timestamp
Note that we do not even store the guild ID or channel ID of a message.

PostgreSQL "guilds" table, one row per server: guild ID, owner ID, which channels are ignored, which
events are disabled, the log channel ID per event, and per-guild settings. This is configuration, not
user data.

Redis holds short-lived operational caches only (invite-code counters, webhook handles, guild
settings); it is not a long-term store.

No presence data, no member profile data, no message content beyond the retention window, and nothing
is shared with or sold to third parties.
```

### Q. Are you storing API Data for 30 days or less?

```
<< 実際の MESSAGE_HISTORY_DAYS の値に合わせる >>
Yes. Message rows are retained for << N >> days and then permanently deleted from the database.
Guild configuration rows are deleted when the app is removed from the server.
```

> ⚠️ §4 のギャップ確認を参照。30日以内であることが強い加点材料です。

### Q. How do users contact you to request deletion of their activity data?

```
Users can run /clearmydata in any server where the app is present, which returns the contact details
for a deletion request. Requests are also accepted at << サポートサーバー招待URL >> and by email at
<< 連絡先メールアドレス >>. We action deletion requests manually against the message store, and in any
case all message rows are automatically purged after << N >> days.
```

### Q. Are you encrypting the data that you store at rest?

```
Yes. Message content and attachment URLs are encrypted with AES-256 in the application layer
(src/db/aes.js) before they are inserted into PostgreSQL, so plaintext message content never touches
disk. The encryption key is held only in the application's environment and is not stored in the
database. << ディスク/ボリューム暗号化やDBアクセス制限をしていれば1文追記 >>
```

### Q. Presence Intent の各設問

```
Not applicable — we are not applying for the Presence Intent.
```

---

## 4. 送信前に埋めるべきギャップ（現時点で不足している要件）

- [ ] **プライバシーポリシーの恒久URL** — 現状コード内は「作者に連絡してください」表記のみ
      (`src/bot/slashcommands/help.js:28-29`, `src/bot/commands/info.js:34-35`)。これは **確実に却下されます**。
      → 雛形: `docs/discord/PRIVACY_POLICY.md`。GitHub Pages 等で公開し、`/help` `/info` の文言もURLに差し替える。
- [ ] **利用規約 (ToS) のURL** — 雛形: `docs/discord/TERMS_OF_SERVICE.md`。Portal のアプリ設定欄にも登録する。
- [ ] **スクリーンショット／動画** — 以下を撮影して恒久URL（Imgur / YouTube限定公開 / 自前ホスト）に：
  1. `/setup` でログチャンネルを設定している画面
  2. メンバー参加ログの埋め込み（Account Age・Invite Used が写っているもの）
  3. 退出／キックログの埋め込み（ロールと実行モデレーターが写っているもの）
  4. メッセージ削除ログの埋め込み（本文が写っているもの＝Message Content の用途証明）
  5. メッセージ編集ログの Before / After
  6. `/ignorechannel` と `/stoplogging` によるオプトアウト画面
- [ ] **データ保持期間の実装確認** — `MESSAGE_HISTORY_DAYS` は現状 **ヘルプ文言にしか登場せず、
      自動削除ジョブがリポジトリ内に実装されていません**（`src/db/interfaces/postgres/delete.js` は
      単体削除のみ）。外部 cron / pg_cron で実際に削除していることを確認してください。
      していない場合、「N日で削除します」という申請は虚偽になります。実装例:

      ```sql
      -- 例: 30日より古いメッセージを削除（cron で日次実行）
      DELETE FROM messages WHERE ts < NOW() - INTERVAL '30 days';
      ```

- [ ] **削除請求の連絡先** — `/clearmydata` は `BOT_CREATOR_NAME` への連絡を案内するのみ。
      メールアドレスかサポートサーバーの恒久的な導線を用意する。

---

## 5. リポジトリと本番の乖離について（申請ブロッカーではない）

§1.1 の通り、本番は Message Content を受信できていますが、このリポジトリの pin（`eris@0.16.2-dev`,
commit `c075c5b`）では構造的に要求できません。**申請作業のためにコードを変更する必要はありません。**
むしろ、このリポジトリの状態に本番を合わせると本文ログが壊れます。

将来このリポジトリから再デプロイする場合にのみ、以下が必要になります。

1. `messageContent` 定数を持つ Eris（0.17 以降、またはそれ相当のフォーク）へ更新する
2. `src/bot/index.js` の intents に `messageContent` を加える。定数を持たない版を使い続けるなら
   数値で直接指定する：

   ```js
   // guilds(1) | guildMembers(2) | guildBans(4) | guildEmojis(8)
   // | guildInvites(64) | guildVoiceStates(128) | guildMessages(512)
   // | messageContent(1 << 15 = 32768)
   intents: 719 | (1 << 15), // = 33487
   ```

> ⚠️ 特権インテントが Portal で無効な状態でこのビットを送ると、ゲートウェイが
> `Disallowed intents specified` を返し（`Shard.js:2403`）**ボットが接続不能になります。**
> 万一審査で却下された場合は、この点に注意して設定を戻してください。

## 6. 申請時の注意点

- **却下は申請単位**です。インテントごとの部分承認はありません。不要な Presence を含めないこと。
- 「My bot needs message content」のような抽象的な説明は却下されます。**具体的な機能名と、
  それが特権インテント無しでは成立しない理由**を書くこと（上記テンプレートはその形式で書いてあります）。
- フォームには**下書き保存機能がありません**。本ファイルの回答を完成させてから、一気に貼り付けて送信してください。
- 却下されても再申請は可能です。ただし審査中もボットは通常通り稼働できます。
- 承認後も **毎年の再申請が必要**です。
