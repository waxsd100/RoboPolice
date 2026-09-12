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

## 3. 申請フォーム 回答テンプレート（そのまま貼り付け可）

> **申請画面そのものは未確認です。** `https://discord.com/developers/applications/308674858781245440/request-additional-intents`
> は Discord ログイン後に JavaScript で描画される画面で、未ログインでは空のシェルHTMLしか返りません
> （実際に Chromium でアクセスして確認済み）。当方に当該アカウントのセッションは無く、
> 認証情報を預かるべきでもないため、**下表は公開情報から再構成した項目一覧**です。
> 実画面と突き合わせて差分があれば、画面のテキストかスクリーンショットをください。すぐ埋めます。

### 3.0 項目チェックリスト

| # | 設問 | 必須性 | 本パックの対応 |
|---|---|---|---|
| 1 | What does your application do? | 必須 | ✅ 用意済み |
| 2 | Do you have a public Privacy Policy...? | **「任意」表示だが実質必須**（No だと却下報告あり） | ✅ Yes |
| 3 | Where is your Privacy Policy available? | 必須 | ✅ 用意済み |
| 4 | Please share a link to your Privacy Policy | **必須・最重要**（恒久URL必須、Discord招待リンク不可） | ✅ URL確定 |
| 5 | Which intents are you applying for? | 必須 | ✅ Members + Message Content の2つのみ |
| 6 | Why do you need the Guild Members intent? | 申請する場合は必須 | ✅ 用意済み |
| 7 | Screenshots / videos demonstrating the use case | 必須級（無いと立証不能） | ⬜ **未撮影＝唯一の残作業** |
| 8 | Are you storing any API Data off-platform? | 必須 | ✅ Yes＋保存項目を明記 |
| 9 | Are you storing API Data for 30 days or less? | 必須（Yes/No の開示。30日以内は要件ではない） | ✅ No＋理由 |
| 10 | How do users contact you to request deletion? | 必須 | ✅ サポートサーバー |
| 11 | Are you encrypting the data you store at rest? | 必須 | ✅ Yes（AES-256） |
| 12-14 | Presence Intent 関連の各設問 | **申請しないなら回答不要／N/A** | ✅ 申請しない |
| 15-17 | Message Content 関連（オプトアウト・保存・ML/AI利用・理由） | 申請する場合は必須 | ✅ 用意済み |
| 18 | 同意チェックボックス → Submit | 必須 | — |

**抜け漏れとして現時点で埋まっていないのは #7 のスクリーンショットだけです。**

### 3.1 各設問の回答（英語）

> 自由記述欄は **1項目あたり2,000文字上限**とされています。以下はすべて上限内です。
> 日本語で提出する場合は §3-J を使ってください。

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

Content is AES-256 encrypted before it is written to our database, a stored row is deleted as soon as
its message is deleted and logged, and administrators can exclude channels with /ignorechannel or
turn logging off entirely with /stoplogging.
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

No presence data and no member profile data is stored at all.
```

### Q. Are you storing API Data for 30 days or less?

> これは Yes/No の**開示質問**であり、30日以内であることは要件ではありません。
> 実態に合わせて No と答え、隣接欄で理由を説明します（虚偽の Yes が一番危険です）。

```
No, not as a fixed window. Stored message rows are the audit record the server's moderators rely on,
and incidents are often investigated well after the fact, so we do not expire them on a timer.

What limits the exposure instead:
- We store only a message ID, an author ID, a timestamp, and the content and attachment URLs in
  AES-256 encrypted form. We do not store the guild ID or the channel ID.
- A stored row is deleted the moment its message is deleted and logged, because the log embed then
  holds the record instead.
- Guild configuration rows are deleted when the app is removed from the server.
- We delete a user's stored rows on request, via /clearmydata and our support server.
- This is a single private server, not a data set aggregated across many communities.

If Discord requires a bounded retention window for approval, we will implement one and update our
privacy policy accordingly.
```

### Q. How do users contact you to request deletion of their activity data?

```
Any member can run /clearmydata in the server, which returns the contact route and links to our
Privacy Policy. Requests are handled by the staff of the community server the app runs in, reachable
at https://discord.com/invite/nobaman. We action deletion requests manually against the message
store, and a row is in any case deleted as soon as its message is deleted and logged.
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

## 3-J. 日本語版 回答テンプレート（日本語で提出する場合）

> 内容は §3.1 の英語版と同一です。どちらか一方を使ってください（併記は冗長で不利になり得ます）。

### Q. このアプリケーションは何をしますか？

```
ロボポリスは「プライベート」な Discord アプリケーションです。一般公開しておらず、第三者が
サーバーに追加することはできません。稼働しているのは1つのコミュニティサーバーのみで、そのサーバーの
運営スタッフが自サーバーのモデレーションのために運用しています。1万ユーザーの基準に達したのは、
その単一サーバーのメンバーが1万人を超えているためであり、多数のサーバーに配布されているためでは
ありません。

本アプリは監査ログBOTです。管理者が /setup でイベント種別ごとにスタッフ専用のログチャンネルを
割り当てると、モデレーション上重要なイベントが発生するたびに、そのチャンネルへ構造化された埋め込みを
投稿します。これによりモデレーターは「サーバーで何が起きたか」を後から確認できます。

記録するイベント: メンバーの参加（アカウント作成からの日数、使用された招待コードを含む）、退出、
キック、BANおよびBAN解除、ニックネーム変更、ロール変更、メンバー認証の通過、メッセージの削除、
メッセージの編集（変更前後）、一括削除、チャンネル／ロール／絵文字／スタンプ／サーバー設定の変更、
招待の作成と削除、ボイスチャンネルの入室・退室・移動。

モデレーター向けコマンド: /setup、/ignorechannel（チャンネルをログ対象外にする）、/stoplogging
（ログを全停止する）、/logbots、/userinfo、/serverinfo、/archive（インシデント報告用に
チャンネルの直近メッセージを書き出す）、/clearmydata。

本アプリはオープンソースの Logger v3（AGPL-3.0）のフォークです。ソースコードは
https://github.com/waxsd100/RoboPolice で全文公開しており、本申請の記述はすべてコードで検証できます。

Presence インテントは使用していないため、申請しません。
```

### Q. データの取り扱いをユーザーに説明する公開プライバシーポリシーはありますか？

```
はい。
```

### Q. プライバシーポリシーはどこで閲覧できますか？

```
本アプリの公開リポジトリ内の、安定した恒久URLで公開しています。またアプリ内からも導線があります:
/help と /info の「Privacy Policy」欄にリンクを表示しており、/clearmydata でもデータ削除請求の
説明とあわせてリンクしています。本アプリが稼働しているコミュニティサーバー内にも掲示しています。
```

### Q. プライバシーポリシーのリンクを共有してください。

```
https://github.com/waxsd100/RoboPolice/blob/master/PRIVACY.md
```

（利用規約: `https://github.com/waxsd100/RoboPolice/blob/master/TERMS.md`）

### Q. どのインテントを申請しますか？

```
Server Members Intent、Message Content Intent
（Presence Intent は申請しません。本アプリでは使用していません。）
```

### Q. なぜ Guild Members（Server Members）インテントが必要ですか？

```
メンバーのライフサイクルのログは本アプリで最も使われている機能であり、このインテント無しでは
実現不可能です。GUILD_MEMBER_ADD / GUILD_MEMBER_REMOVE / GUILD_MEMBER_UPDATE は、このインテントが
無ければそもそも配信されません。これらはユーザー操作を伴わない受動的なサーバーイベントであるため、
スラッシュコマンドで代替することは原理的にできません。誰かが黙って退出したとき、コマンドを
実行する契機が存在しないからです。

具体的な用途:

1. 参加ログ — 参加したメンバー、アカウント作成からの日数（荒らし・捨て垢を判断する標準的な指標）、
   サーバーのメンバー数、使用された招待コードを記録します。招待コードの特定は、GUILD_MEMBER_ADD の
   たびにサーバーの招待使用回数とキャッシュを比較することで行っています。
2. 退出・キックログ — GUILD_MEMBER_REMOVE の際に監査ログを参照し、自発的な退出とキックを区別し、
   実行したモデレーターを特定し、そのメンバーが保持していたロールを記録します。これによりスタッフは
   どの権限が失われたかを把握できます。
3. ニックネーム・ロール・メンバー認証のログ — GUILD_MEMBER_UPDATE から取得し、誰がいつ特権ロールを
   得たかを追跡できるようにします。
4. 他のすべてのログ埋め込みにおける表示名の解決 — メンバー情報（ニックネーム、ロール、アバター）が
   あることで、削除ログやBANログが単なる数値IDではなく「Taro（ニックネーム: Mod-Taro）」と表示できます。
5. モデレーター向けコマンド /userinfo。

メンバーデータは読み取るのみです。メンバーのプロフィール情報はデータベースに一切書き込んでおらず、
ゲートウェイのメモリ上のキャッシュに存在するだけで、再起動時に破棄されます。これらはすべて
本アプリが稼働する単一サーバー内に限定されています。
```

### Q. なぜ Message Content インテントが必要ですか？

```
本アプリの中核機能は、削除・編集されたメッセージの内容をモデレーターに提示することです。削除された
メッセージを Discord API から再取得することはできないため、削除が起きる「前」に内容を受け取っておく
以外に方法がありません。モデレーターがコマンドを実行できる時点では、証拠は既に失われています。
したがってスラッシュコマンドやインタラクションによる代替設計は成立しません。

Message Content の用途は以下に限られます:

1. メッセージ削除ログ — 削除されたメッセージの本文と画像添付をスタッフに表示します。詐欺・
   フィッシングリンク、荒らしスパム、個人情報晒し、ハラスメントへの対処や、他のモデレーターによる
   削除が適切だったかの検証に使われています。
2. メッセージ編集ログ — 変更前後の差分を表示します。「無害な内容を投稿してから広告や詐欺リンクに
   編集する」という、Discord の標準UIでは見えない挙動を検知するために必要です。
3. 一括削除ログ — 同様の目的で、大量削除に対応します。
4. /archive — メッセージ管理権限を持つモデレーターが、インシデント報告のために1チャンネルの
   直近メッセージを書き出せるようにします。

メッセージ内容を、機械学習やAIモデルの学習、統計、プロファイリング、広告、分析に使用することは
一切ありません。第三者への共有も行いません。用途は、そのメッセージが投稿されたのと同じサーバーへ
返すログ埋め込みの生成のみです。

内容はデータベースへの書き込み前に AES-256 で暗号化されます。保存された行は、そのメッセージが削除
されてログに出力された時点で削除されます。また管理者は /ignorechannel でチャンネルを除外でき、
/stoplogging でログを完全に停止できます。
```

### Q. 用途を示すスクリーンショットまたは動画のリンクを提供してください

```
<< §4 のチェックリストに沿って撮影し、恒久URLを貼る >>
```

### Q. API データを Discord 外に保存していますか？

```
はい。削除・編集ログの生成に必要な最小限のみ保存しています。すべて自前で運用するインフラ上に
留まり、第三者に送信されるものはありません。

PostgreSQL の messages テーブル（受信したメッセージごとに1行）:
  - メッセージID（平文）
  - 投稿者ID（平文）
  - メッセージ本文（AES-256 で暗号化）
  - 画像添付のURL（AES-256 で暗号化）
  - タイムスタンプ（平文）
メッセージのサーバーIDおよびチャンネルIDは保存していません。

PostgreSQL の guilds テーブル（サーバーごとに1行）: サーバーID、オーナーID、除外チャンネル、
無効化されたイベント、イベントごとのログチャンネルID、サーバー別設定。これは設定情報であり
ユーザーデータではありません。

Redis には短命な運用キャッシュ（招待コードの使用回数、Webhookハンドル、サーバー設定）のみを保持し、
再起動時に消去されます。

プレゼンスデータおよびメンバープロフィールは一切保存していません。
```

### Q. API データの保存期間は30日以内ですか？

```
いいえ。固定の期限は設けていません。保存しているメッセージ行はサーバーのモデレーターが依拠する
監査記録であり、事案の調査は発生からかなり経ってから行われることがあるため、時間で自動的に
失効させていません。

代わりに、以下によって影響範囲を限定しています:
- 保存するのはメッセージID、投稿者ID、タイムスタンプ、および AES-256 で暗号化した本文と添付URLのみ
  です。サーバーIDとチャンネルIDは保存していません。
- 保存された行は、そのメッセージが削除されてログに出力された時点で削除されます。ログ埋め込みが
  記録の役割を引き継ぐためです。
- サーバー設定の行は、本アプリがそのサーバーから削除された時点で削除されます。
- 削除請求があれば当該ユーザーの行を削除します（/clearmydata およびサポートサーバー経由）。
- これは単一のプライベートサーバーであり、多数のコミュニティを横断して集積されたデータセットでは
  ありません。

承認にあたり保存期間の上限設定が必要であれば、実装のうえプライバシーポリシーを更新します。
```

### Q. ユーザーは活動データの削除をどのように請求できますか？

```
サーバー内で /clearmydata を実行すると、連絡方法とプライバシーポリシーへのリンクが表示されます。
請求は本アプリが稼働するコミュニティサーバーのスタッフが対応し、連絡先は
https://discord.com/invite/nobaman です。請求を受けた場合は保存されているメッセージ行を手動で
削除します。また請求の有無にかかわらず、メッセージが削除されてログに出力された時点でその行は
削除されます。
```

### Q. 保存しているデータは保存時に暗号化していますか？

```
はい。メッセージ本文と添付URLは、PostgreSQL に挿入される前にアプリケーション層（src/db/aes.js）で
AES-256 により暗号化されます。したがって平文のメッセージ内容がディスクに書かれることはありません。
暗号鍵はアプリケーションの実行環境上にのみ存在し、データベースには一切保存されません。
データベースへのアクセスはアプリケーション自身のホストに限定されています。
```

### Q. Presence Intent に関する各設問

```
該当なし（Presence Intent は申請しません）。
```

---

## 4. 送信前の残作業

- [x] **プライバシーポリシー** — `PRIVACY.md`（英日併記）をリポジトリルートに作成。public リポジトリなので
      `https://github.com/waxsd100/RoboPolice/blob/master/PRIVACY.md` が恒久URLとして機能します。
      **PR #8 を master にマージした時点で有効になります。**
- [x] **利用規約** — `TERMS.md`。Developer Portal の Terms of Service URL 欄にも登録してください。
- [x] **BOT内からポリシーへ導線** — `/help`・`/info`・`/clearmydata` にポリシーURLを表示するよう変更。
      「Where is your Privacy Policy available?」への回答の裏付けになります。
- [x] **保持期間に関する記述を実態に合わせた** — 自動削除は実装しない方針のため、`PRIVACY.md` は
      「固定の保持期限は設けない」と明記。併せて、**上流 Logger 由来で `/clearmydata` と `/help` が
      「N日後に自動削除される」と表示していた虚偽の告知を削除**しました（実装が存在しないため）。
      `MESSAGE_HISTORY_DAYS` は `.env.example` 上で「BOTは強制しない」と注記。
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
- [ ] **外部での定期削除の有無を確認** — cron や pg_cron で `messages` を掃除しているなら、その事実を
      `PRIVACY.md` 第5項と申請回答に反映してください（あるなら明記した方が審査上は有利です）。

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
