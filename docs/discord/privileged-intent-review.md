# Discord 特権インテント審査 申請パック（ロボポリス）

Discord から「10,000ユーザー到達につき特権インテントの審査申請が必要」という通知が届いたための申請資料です。
残り猶予は通知時点で **29日**。Developer Portal → 該当アプリ → **Bot** タブ → *Privileged Gateway Intents* セクションの
**Apply for Access** ボタンから申請します。

| 項目 | 値 |
|---|---|
| アプリ名 | ロボポリス (RoboPolice) |
| アプリケーション ID | `308674858781245440` |
| ベース | Logger v3 (AGPL-3.0) のフォーク |
| ソース | https://github.com/waxsd100/RoboPolice （public） |
| 公開種別 | **プライベートBOT**（一般公開しておらず、第三者は追加できない） |
| 設置サーバー数 | **1サーバーのみ**（https://discord.com/invite/nobaman ） |
| 1万ユーザー到達の理由 | 配布数ではなく、**その1サーバーのメンバーが1万人超**であるため |
| プライバシーポリシー | https://github.com/waxsd100/RoboPolice/blob/master/PRIVACY.md |
| 利用規約 | https://github.com/waxsd100/RoboPolice/blob/master/TERMS.md |

> **この申請の性格**：本BOTは1つのコミュニティが自分たちのモデレーションのために自前で動かしている
> プライベートBOTです。審査では「不特定多数に配布されたBOTがデータを集めている」ケースと明確に
> 区別されるよう、**単一サーバー運用であること**を各回答で明示します（Discord にとってはリスクの
> 低い類型です）。逆に、公開BOTのような大げさな説明を書くと不利になります。

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

> フォームの自由記述欄は **1項目あたり2,000文字上限**です。以下はすべて上限内です。
> URL・保持日数はすでに確定値を埋めてあります。事実が変わった場合のみ書き換えてください。

### Q. What does your application do?

```
RoboPolice (ロボポリス) is a PRIVATE Discord application. It is not publicly listed and cannot be
added by third parties: it runs in exactly one community server, operated by that server's own staff
for that server's own moderation. It crossed the 10,000-user threshold because that single server has
more than 10,000 members, not because the app is distributed widely.

The app is an audit logger. Server administrators use /setup to bind each event type to a staff-only
log channel, and the app posts a structured embed there whenever a moderation-relevant event occurs,
giving moderators a reviewable record of what happened.

Logged events: member joins (with account age and the invite code used), member leaves, kicks, bans
and unbans, nickname changes, role changes, membership-screening completions, message deletions,
message edits (before/after), bulk deletions, channel/role/emoji/sticker/server-setting changes,
invite creation and deletion, and voice channel join/leave/move.

Moderator commands: /setup, /ignorechannel (exclude a channel from logging), /stoplogging (turn
logging off entirely), /logbots, /userinfo, /serverinfo, /archive (export recent messages of one
channel for an incident report), and /clearmydata.

The app is a fork of the open-source Logger v3 project (AGPL-3.0). The full source is public at
https://github.com/waxsd100/RoboPolice, so every claim in this application can be verified in code.

We are NOT applying for the Presence Intent; the app does not use it.
```

### Q. Do you have a public Privacy Policy telling your users about their data usage?

```
Yes.
```

### Q. Where is your Privacy Policy available?

```
It is published at a stable, permanent public URL in the app's own public repository, and it is
linked from inside the app itself: the /help and /info commands both show a "Privacy Policy" field
linking to it, and /clearmydata links to it when explaining how to request data deletion. It is also
pinned in the community server the app runs in.
```

### Q. Please share a link to your Privacy Policy.

```
https://github.com/waxsd100/RoboPolice/blob/master/PRIVACY.md
```

（利用規約を求められた場合: `https://github.com/waxsd100/RoboPolice/blob/master/TERMS.md`）

### Q. Which intents are you applying for?

```
Server Members Intent, Message Content Intent
(Presence Intent is NOT requested — the app does not use it.)
```

### Q. Why do you need the Guild Members (Server Members) intent?

```
Member lifecycle logging is the most used feature of this app, and it is impossible without this
intent: GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE / GUILD_MEMBER_UPDATE are simply not delivered without
it. These are passive server events, so slash commands cannot substitute for them — there is no user
interaction to hang a command off when someone quietly leaves the server.

Concretely, the intent powers:

1. Join logs — the joining member, their account creation age (a standard raid/alt-account signal for
   moderators), the server member count, and which invite code was used. Invite attribution is done
   by diffing the guild's invite uses against our cache on each GUILD_MEMBER_ADD.
2. Leave and kick logs — on GUILD_MEMBER_REMOVE we read the audit log to distinguish a voluntary
   leave from a kick, name the responsible moderator, and record the roles the member held, so staff
   can see what access was lost.
3. Nickname, role and membership-screening logs — from GUILD_MEMBER_UPDATE, so staff can see who
   gained a privileged role and when.
4. Member resolution for every other log embed — the member object (nickname, roles, avatar) is what
   lets a deletion or ban log read "Taro (nickname: Mod-Taro)" instead of a bare snowflake ID.
5. The /userinfo moderation command.

We only read member data. No member profile data is written to our database at all; member objects
live in the gateway cache in memory and are discarded on restart. This is all scoped to the single
server the app runs in.
```

### Q. Why do you need the Message Content intent?

```
The core feature of the app is showing moderators what a deleted or edited message actually said.
A deleted message can never be retrieved from the Discord API, so the only way to provide this is to
have received the content before the deletion happened. No slash-command or interaction-based design
can replace this: by the time a moderator could run a command, the evidence is gone.

Message Content is used for exactly these features:

1. Message deletion logs — the text and image attachments of the removed message are shown to staff.
   This is what the community uses to act on scam/phishing links, raid spam, doxxing and harassment,
   and to review whether another moderator's deletion was appropriate.
2. Message edit logs — a before/after diff, which catches "post something innocuous, then edit it
   into an advertisement or a scam link" behaviour that is invisible in Discord's own UI.
3. Bulk deletion logs — the same, for mass deletions.
4. /archive — lets a moderator with Manage Messages export recent messages of one channel for an
   incident report.

We do NOT use message content for machine learning, AI model training, statistics, profiling,
advertising or analytics, and we never share it with third parties. It is used solely to render the
log embed posted back into the same server the message came from.

Content is AES-256 encrypted before it is written to our database, rows are deleted after 30 days by
an automated job, and administrators can exclude channels with /ignorechannel or turn logging off
entirely with /stoplogging.
```

### Q. Please provide links to screenshots and/or videos that demonstrate your use case

```
<< §4 のチェックリストに沿って撮影し、恒久URLを貼る >>
```

### Q. Are you storing any API Data off-platform?

```
Yes, the minimum required to render deletion and edit logs. Everything stays on infrastructure we
operate ourselves; nothing is sent to any third party.

PostgreSQL "messages" table, one row per message seen:
  - message ID (plaintext)
  - author ID (plaintext)
  - message content (AES-256 encrypted)
  - image attachment URLs (AES-256 encrypted)
  - timestamp (plaintext)
We do not even store the guild ID or channel ID of a message.

PostgreSQL "guilds" table, one row per server: guild ID, owner ID, which channels are ignored, which
events are disabled, the log channel ID per event, and per-server settings. This is configuration,
not user data.

Redis holds short-lived operational caches only (invite-code counters, webhook handles, guild
settings), cleared on restart.

No presence data, no member profile data, no message content beyond the retention window.
```

### Q. Are you storing API Data for 30 days or less?

```
Yes. Message rows are retained for 30 days and then permanently deleted. This is enforced in code by
a scheduled deletion job (src/bot/modules/retention.js) that runs hourly and deletes any row older
than the configured window; it is not a manual process. Guild configuration rows are deleted when the
app is removed from the server.
```

### Q. How do users contact you to request deletion of their activity data?

```
Any member can run /clearmydata in the server, which returns the contact route and links to our
Privacy Policy. Requests are handled by the staff of the community server the app runs in, reachable
at https://discord.com/invite/nobaman. We action deletion requests manually against the message
store. Independently of any request, all message rows are automatically deleted after 30 days.
```

### Q. Are you encrypting the data that you store at rest?

```
Yes. Message content and attachment URLs are encrypted with AES-256 in the application layer
(src/db/aes.js) before they are inserted into PostgreSQL, so plaintext message content never touches
disk. The encryption key is held only in the application's runtime environment and is never stored in
the database. Database access is restricted to the application's own host.
```

### Q. Presence Intent の各設問

```
Not applicable — we are not applying for the Presence Intent.
```

---

## 4. 送信前の残作業

- [x] **プライバシーポリシー** — `PRIVACY.md`（英日併記）をリポジトリルートに作成。public リポジトリなので
      `https://github.com/waxsd100/RoboPolice/blob/master/PRIVACY.md` が恒久URLとして機能します。
      **PR #8 を master にマージした時点で有効になります。**
- [x] **利用規約** — `TERMS.md`。Developer Portal の Terms of Service URL 欄にも登録してください。
- [x] **BOT内からポリシーへ導線** — `/help`・`/info`・`/clearmydata` にポリシーURLを表示するよう変更。
      「Where is your Privacy Policy available?」への回答の裏付けになります。
- [x] **保持期間の実装** — `src/bot/modules/retention.js` を追加し、`MESSAGE_HISTORY_DAYS`（既定30）より
      古い行を毎時バッチ削除します。これまで自動削除は実装されておらず、BOTがユーザーに告知していた
      「N日で削除」が事実と異なる状態でした。
- [ ] **スクリーンショット／動画** — 以下を撮影して恒久URL（Imgur / YouTube限定公開 等）に：
  1. `/setup` でログチャンネルを設定している画面
  2. メンバー参加ログ（Account Age・Invite Used が写っているもの）
  3. 退出／キックログ（ロールと実行モデレーターが写っているもの）
  4. **メッセージ削除ログ（本文が写っているもの）= Message Content の用途証明**
  5. メッセージ編集ログの Before / After
  6. `/ignorechannel` と `/stoplogging` によるオプトアウト画面
  7. `/help` のプライバシーポリシー欄（BOT内導線の証明）
- [ ] **Developer Portal 側の登録** — General Information の Privacy Policy URL / Terms of Service URL に
      上記2つのURLを入力。
- [ ] **`MESSAGE_HISTORY_DAYS` の値確認** — 本番 `.env` が30以外なら `PRIVACY.md` の記述と揃えること
      （申請の「30日以内」回答と矛盾させない）。

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
- **プライベートBOTであることを隠さないでください。** 単一サーバー運用・公開していない・ソース公開済み、
  という条件は審査上むしろ有利に働きます。
