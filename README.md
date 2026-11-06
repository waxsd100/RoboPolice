# ロボポリス (RoboPolice)

RoboPolice is a **private** [Discord](https://discord.com) audit-logging app. It is not publicly
listed and cannot be added by third parties. It runs only in servers we operate: one community
server, whose staff use it for that server's own moderation, plus a few private test servers used to
stage changes.

It records moderation-relevant events — member joins and leaves, kicks, bans, role and nickname
changes, message deletions and edits, channel/role/emoji/server-setting changes, invite usage and
voice activity — and posts them to staff-only log channels chosen with `/setup`.

Support: https://discord.com/invite/nobaman

A fork of [Logger v3](https://github.com/curtisf/logger) by Curtis Fowler, licensed
AGPL-3.0-or-later.

## Legal

- [Privacy Policy](https://github.com/waxsd100/RoboPolice/wiki/Privacy-Policy)
- [Terms of Service](https://github.com/waxsd100/RoboPolice/wiki/Terms-of-Service)

These are the documents registered with Discord for this application. **Keep them in sync with what
the code actually does** — if you change what is stored, where it is sent, or how long it is kept,
update them in the same change. The application for privileged intent access attests that they are
accurate, and the reviewer can read this repository.

## Privileged intents

The app requires three privileged intents, all enabled in the Developer Portal:

| Intent | Why |
|---|---|
| **Server Members** | `GUILD_MEMBER_ADD` / `REMOVE` / `UPDATE` are not delivered without it, so join, leave, kick, nickname and role logging cannot work. Also resolves nicknames and roles shown in every other log embed. |
| **Message Content** | A deleted message cannot be fetched back from the API, so its content must be received before deletion to be shown in a deletion or edit log. |
| **Presence** | `PRESENCE_UPDATE` is used only to log changes to a member's custom status text (`presenceUpdate` event). Online status, games and other activities are ignored and never stored. |

See [`docs/discord/privileged-intent-review.md`](docs/discord/privileged-intent-review.md) for the
intent review submission, where every claim is mapped to the code that backs it.

## What is stored

Short version; the Privacy Policy is authoritative.

| Data | Where | Retention |
|---|---|---|
| Message ID, author ID, channel ID, server ID, timestamp, content and image URLs, as received and as read back from channel history (not encrypted by the app; see below) | PostgreSQL `messages`, `message_attachments` (and `message_backfill`, how far back each channel was read) | `MESSAGE_HISTORY_DAYS` days, or forever if unset; all of a server's go when the app leaves it |
| Per-server settings (log channels, ignored channels, disabled events), and the server's name, icon URL, member count and when the app joined | PostgreSQL `guilds`, `guild_emojis` (custom emojis with an AI description), `guild_event_logs`, `guild_ignored_channels`, `guild_disabled_events` | Until the app leaves the server |
| Invite counters, webhook handles, guild settings | Redis | 3 hours |
| With `SERVER_LORE=true` only: what each server is like, taken out of its stored messages in `@everyone` channels (running jokes, words, happenings, topics, and how it talks; nothing about a single member) | PostgreSQL `guild_lore_chunks`, `guild_lore_facts`, `guild_lore_style` | The last `SERVER_LORE_WEEKS` weeks (default 8), taken out again when the messages change; all of a server's go when the app leaves it |
| The YouTube channels the bot follows (`YOUTUBE_CHANNELS`), their descriptions and every video read from them, each server's event setting, plus summaries of linked videos' contents (public YouTube data) | PostgreSQL `youtube_channels`, `youtube_videos`, `youtube_summaries`, `guild_youtube_summaries`, `guilds.youtube_live_events` | Channels and videos until the bot no longer follows the channel; summaries while their video is stored, or else until no server that asked for them remains |

Message content, image URLs and message embeddings are stored as they are: the app no longer
encrypts them with `AES_KEY` (migration 006 decrypted what was stored), since encryption is moving
into the database with pgcrypto. Until then, anyone who can read the database can read them.
`AES_KEY` is still needed: for invite codes in Redis, and to run migrations 003 and 006 on a database
that still has encrypted rows.

Message rows are written **only for servers that have a message deletion or edit log channel
configured** — a server with none never has message content stored, since nothing could read it back.

Messages sent before the app stored them (before it joined, before the server set a message log, or
in channels quiet since) are **read back from each channel's history** (`historyBackfill.js`), under
the same rules: text, voice, announcement and stage channels and active threads the app can read back,
not ignored channels, not bots or automod notices. Each is stored with its own time, a message already
stored is left as it is, and image URLs go with it. How far back, whichever comes first: a date,
`HISTORY_BACKFILL_SINCE` (`YYYY-MM-DD`, from the start of that day in Japan), and/or a number of days,
`HISTORY_BACKFILL_DAYS` (`0` for no limit; with neither set, everything); and a number of messages per
channel, `HISTORY_BACKFILL_MAX_MESSAGES`. Never further than `MESSAGE_HISTORY_DAYS`: anything older
would be pruned at once. 100 messages a request, one request every `HISTORY_BACKFILL_DELAY_MS` (default 1000); where each
channel got to is kept in `message_backfill`, so a restart goes on from there. A channel that stopped
at the limits is read on from where it stopped when they are widened later (an earlier date, more
days or more messages); one read to its very start is not read again. Every worker does the servers it hosts, checking hourly for
new channels and servers that set a message log. `HISTORY_BACKFILL=false` turns it off. A large
server's history takes disk space: with no retention set and no limit given, all of it is read back.

## コマンド一覧

### メンション（BOT に話しかける）

`@ロボポリス` と BOT にメンションして、文章で頼みます。使える量は1人ごとにサーバーをまたいでトークン数（Gemini の料金表どおり、高いモデルほど重く数えます）で決まっていて、5時間あたり15万トークン・1週間あたり75万トークンまで（Claude の無料版くらい）（最初に使った時から数え、上限に達したら戻る時刻を伝えます）。オーナー以外のサーバーでは、サーバー全体で1日30回まで。

| 使い方 | 例 | 必要な権限 |
|---|---|---|
| 話しかける（チャット） | `@ロボポリス 最近の配信でおすすめは？` | なし |
| イベントを登録する | `@ロボポリス 11/3 19時から交流会` / `@ロボポリス これ登録して https://…` | イベントの管理 |
| フォーラムに投稿する | `@ロボポリス #募集 に交流会の募集を立てて` | そのフォーラムに投稿できること |
| メッセージをもとに作る | 元のメッセージに返信する形で `@ロボポリス これをイベントにして` | 上と同じ |
| 作ったものを後から直す | BOT の「登録しました / 投稿しました」かフォーラムの投稿に返信して `@ロボポリス 開始を20時に` | 上と同じ |
| 画像を差し替える・AI で編集する | 上の返信に画像を添付する、または `@ロボポリス 画像を夕焼けにして` | 上と同じ |
| 会話を続ける | BOT の返事に返信する（メンションはなくてもよい） | なし |

プレビューには「登録する / 投稿する」「内容を修正」「画像を指示で変更」「キャンセル」と、画像の候補（画像1〜4）と作り方（切り抜き・全体表示・AIで作成・なし）のボタンが出ます。ボタンを押せるのは依頼した人だけです。

### スラッシュコマンド

BOT がサーバーに入った瞬間から、すべてのイベントを記録します。スタッフだけが見られるチャンネル `#robopolice-logs`（`@everyone` から非表示、管理者には見える）を作り、全イベントの出力先にします（BOT にチャンネルの管理と Webhook の管理が必要。ないときは `/setup` で手動設定）。すでにログを設定しているサーバーはそのまま。`AUTO_LOG_CHANNEL=false` で止められます。

| コマンド | 内容 | 必要な権限 |
|---|---|---|
| `/youtube sync` | BOT が見ているチャンネルを読み直し、新しい動画と配信の状態を取り込む（普段は自動。オーナーのサーバーからのみ） | サーバーの管理 |
| `/youtube summarize count:<1〜50> force:<True/False> url:<動画リンク>` | まだ要約していない動画を新しい順に `count` 本（初期値 3）要約する。Gemini の Batch API にまとめて依頼し（料金は半分、終わるまで数分〜最大24時間）、終わったらコマンドを使ったチャンネルで知らせる。各チャンネルの最新の動画と5分以内の短い動画（`VIDEO_SUMMARY_FLEX_SECONDS`）は、Flex 推論でその場で要約する。`force:True` で要約済みも作り直す。`url` を指定するとその1本だけを要約し、終わったら内容を表示する（保存済みならすぐ表示。他のチャンネルの動画でも可）。`VIDEO_SUMMARY_BATCH=false` なら、その場で3本ずつ（`VIDEO_SUMMARY_CONCURRENCY`）要約する | サーバーの管理 |
| `/youtube liveevents enabled:<True/False>` | 配信をサーバーのイベントとして自動で登録する（予定の枠で作成、開始で開催中、終了で終了）。説明の先頭に AI が配信内容の紹介を書き、終了後はアーカイブを自動で要約する。新しく投稿された動画も「📺 新着動画」として投稿から24時間イベントにする | サーバーの管理（BOT にイベントの管理） |
| `/youtube show` | 設定しているチャンネル、保存している動画の数、配信の予定、配信のイベント登録の有無を表示する | サーバーの管理 |
| `/replylength length:<long/normal/short>` | メンションへの返事の長さをサーバーごとに決める。`long`（初期値）は長くても500文字程度、`normal` は内容に合わせて（あいさつは1〜2文、説明は400文字程度まで）、`short` は答えだけを短く（200文字程度まで）。`length` を省くと今の設定を表示する | サーバーの管理 |
| `/persona streamer:<True/False>` | メンションへの返事で、YouTube チャンネルの配信者本人になりきるか（`True`、初期値）、配信者にはなりきらずサーバーの BOT として話すか（`False`）をサーバーごとに決める。`streamer` を省くと今の設定を表示する | サーバーの管理 |
| `/assistantrules text:<お願い> clear:<True>` | メンションの返事で AI に守ってほしいこと（避ける話題、使わない言葉、ネタバレの扱いなど、2000文字まで）をサーバーごとに決める。AI はこれと、サーバーのルールチャンネル（Discord で設定したもの、なければ「ルール」「rules」「規約」を含む名前のチャンネル）の最新20件を読み、それに従って返事をする（システムの指示より厳しくする方向だけ）。省くと今の内容を表示、`clear:True` で消す | サーバーの管理 |
| `/setup via_presets` | よく使うログをまとめて有効にする。まだ何も出力していないチャンネルでは最初から「すべて」を選んであり、「このまま保存」で全イベントを記録する（`via_individual_event` も同じ） | Webhook の管理・チャンネルの管理・監査ログの表示 |
| `/setup via_individual_event` | ログの種類を1つずつ選んで有効にする | 同上 |
| `/setup list` | ログの出力先チャンネルの一覧を表示する | 同上 |
| `/setup assistant` | AI（メンション）の設定をまとめて変える。話し方（`/persona`）、返事の長さ（`/replylength`）、配信・新着動画のイベント登録（`/youtube liveevents`。`YOUTUBE_API_KEY` があるとき）を選択メニューで選ぶと、すぐ保存される | 同上＋サーバーの管理 |
| `/stoplogging channel:<チャンネル>` | 指定したチャンネルへのログ出力を止める（`other` ですべて止める） | Webhook の管理・チャンネルの管理 |
| `/ignorechannel channel-to-ignore:<チャンネル>` | 指定したチャンネルの出来事をログに出さない／出すを切り替える（`optional` で一覧・リセット） | Webhook の管理・チャンネルの管理 |
| `/logbots` | 他の BOT の操作もログに出すかを切り替える（初期値: 出さない） | Webhook の管理・チャンネルの管理 |
| `/clearmydata` | 保存データの削除の方法を表示する | なし |
| `/invite` | BOT の招待リンクを表示する | なし |
| `/help event:<イベント> guide:<項目>` | ヘルプを表示する | なし |

コマンドの説明と選択肢は英語と日本語で登録し、Discord の表示言語が日本語の人には日本語で表示されます。返事も同じく、日本語の人には日本語、それ以外の人には英語で返します（`src/bot/utils/i18n.js`。Discord が言語を送らないときは日本語）。サーバーやユーザーの情報、BOT の応答確認は Discord の画面やテキストコマンド（`%serverinfo`・`%userinfo`・`%ping`）で見られるので、スラッシュコマンドにはありません。

`/youtube` の新しいサブコマンドや `/replylength`・`/persona` のような新しいコマンドを追加したときは、下の `%setcmd` でコマンドを登録し直さないと Discord に表示されません。

### テキストコマンド（`%` は `GLOBAL_BOT_PREFIX`）

| コマンド | 内容 | 使える人 |
|---|---|---|
| `%setcmd guild` / `%setcmd global` | スラッシュコマンドを Discord に登録する（`guild` はこのサーバーだけですぐ反映、`global` は全サーバー） | `CREATOR_IDS` の人 |
| `%setchannel` | ログの出力先チャンネルとイベントを設定する | Webhook の管理・チャンネルの管理・監査ログの表示 |
| `%stoplogging` / `%ignorechannel` / `%logbots` | スラッシュコマンドと同じ | 管理者・チャンネルの管理 |
| `%reset` | サーバーのログ設定をすべて消す（`yes` と返信して確定） | 管理者 |
| `%help` / `%info` / `%invite` / `%ping` / `%serverinfo` / `%userinfo` / `%clearmydata` | ヘルプ・BOT の情報・招待リンクなど | だれでも |
| `%tokenlimit` / `%tokenlimit 5h 300000` / `week 1500000` / `flex 70` / `5h default` / `unlimited on`・`off` | このサーバーのメンションのトークン上限（1人あたり、5時間・1週間）と、低速モード（Flex）に切り替える割合を表示・変更する（0 は上限なし・切り替えなし、`default` で既定に戻す）。`unlimited on` でこのサーバーの制限（上限・低速モード・1日の回数）をすべて外す。使った量はサーバーをまたいで数え、メンションしたサーバーの上限と比べる | `CREATOR_IDS` の人 |
| `%replymodel` / `%replymodel model gemini-4-argon` / `thinking low` / `model default` | このサーバーのメンションの返事に使うモデルと思考の深さ（`minimal`・`low`・`medium`・`high`）を表示・変更する（`default` で `GEMINI_MODEL`・`GEMINI_THINKING_LEVEL` に戻す）。選べるのは料金表（`geminiPrices.js`・`MENTION_TOKEN_PRICES`）にある画像以外のモデル。高いモデルほど利用者のトークン上限も早く減る。強いモデルに任せるとき（`think_deeper`）のモデルは変わらず、混み合っているときは思考の深さが下がる | `CREATOR_IDS` の人 |
| `%debugfooter on` / `off` | このサーバーのメンション返信の下に、答えたモデル・使ったトークン・フォールバックを小さい灰色の字で出す（`-# model: gemini-3.8-flash → gemini-4-argon (flex) · tokens: in … (cached …) · out … · thinking … · N Gemini calls · fallback: …`）。初期はオフ。引数なしで今の設定を表示 | `CREATOR_IDS` の人 |
| `%eval` / `%reload` / `%reindexcommands` | 開発用 | `CREATOR_IDS` の人 |

## Events and forum posts from a mention

Mention the app with a description, an event page URL, or a Discord message link
(`@RoboPolice 11/3 19時から交流会 https://...`, `@RoboPolice これを募集フォーラムに立てて`), or reply to a
message and mention it. It drafts either a server scheduled event or a forum post, shows it with
Register / Post and Cancel buttons, and creates it only after the requester confirms. Anyone can
mention it; what a request makes is checked when it is drafted. Registering or changing an event
needs **Manage Events** from the requester (or the owner, an administrator, `STAFF_ROLE_ID`
staff, or a `CREATOR_IDS` user) and from the app; a forum post needs both the requester (unless a
`CREATOR_IDS` user) and the app to be able to post in that forum, and is sent with mentions disabled so drafted text can't ping anyone.

A mention that does not ask for an event or a forum post (a greeting, a question, small talk) gets a
plain chat reply (`submit_chat_reply`), with pings disabled. The model plays the creator of the
server's YouTube channel (set with `/youtube`), taking their way of talking from the stored videos
and streams (`search_youtube`); Discord's BOT tag marks the replies as the bot's. It plays the voice
only: schedules, announcements or promises that are not in the stored data are never made up as the
creator's. `CHAT_PERSONA` adds the operator's own character notes. A request that is for an event or a post but can't be
made (no date, or the linked message is about something else) is an error, not a chat reply, and is
shown as `⚠️ 作成できませんでした`.

Replying to the bot's answer (with a mention) continues the conversation: the reply chain is
followed back up to 10 messages and given to the model oldest first, with the bot's own messages
labeled as its own (`あなた（BOT）`) and the requester's marked; the model is told to answer as the
continuation of it. Nothing is stored for this.

What was just being talked about in the channel goes with every request too, as far as it bears on
it (`src/bot/modules/recentTopics.js`): of the last `MENTION_RECENT_MESSAGES` messages (default 50,
at most 100) of the past `MENTION_RECENT_HOURS` (default 12), the ones closest in meaning to the
request (at most 8), embedded as the mention comes in, oldest first with who said them. So "さっきの
話だけど" or "それってどうなの？" is answered with the talk it is about, and a request about
something else gets none of it. The bot's own and other bots' messages, commands and noise are left
out, so it does not carry on from what it said itself. `MENTION_RECENT_TOPICS=false` turns it off.

The server profile lists the server's custom emojis (those not limited to roles), and chat replies
use one now and then where it fits. An emoji the model writes as `:name:` is turned into the
server emoji of that name.

With `WIKI_URLS` set, the community's wiki is knowledge too (`src/bot/modules/wikiKnowledge.js`):
the worker owning shard 0 reads every page of it once a week (one page a second, only the `/d/`
pages its robots.txt allows), splits each at its headings, and stores the parts with embeddings in
`knowledge_pages` and `knowledge_sections` (as source `wiki`; images in `knowledge_section_images`).
Gemini then takes knowledge out of each part, as structured JSON, into `knowledge_facts` (other names
in `knowledge_fact_aliases`): characters (name, other names and readings, who they are and how they
look), quotes (the words, and who said them when) and terms (running jokes, the community's words
and what they mean), each embedded on its own; a part is read again only when it changes. The model
searches all of it with `search_wiki` (the knowledge first, then the pages for detail), and uses its quotes now and then as the streamer would. It is fans' writing, so
the model does not state it as the streamer's own word.

With `TWITTER_ACCOUNTS` set, the streamer's own X posts are knowledge too
(`src/bot/modules/twitterKnowledge.js`). They are read through FxTwitter's public API
(api.fxtwitter.com), not X's: the first time up to `TWITTER_MAX_PAGES` pages back, then every
`TWITTER_REFRESH_HOURS` until posts already stored, one request every 2 seconds, a failed request
tried again twice. Reposts of others are left out. Posts are stored in `x_posts` (media URLs in `x_post_media`), and each
month's posts are written as one page of the knowledge tables as source `x` (one line per post with
its date and URL), so knowledge is taken out of them and they are searched with `search_wiki` together
with the wiki; the
model gives a post's URL when it mentions one. FxTwitter is a third-party service and may change or
stop; nothing stored is lost then.

With `DISCORD_KNOWLEDGE_USERS` set (comma-separated user IDs, e.g. the streamer's own account), their
own Discord messages are knowledge too (`src/bot/modules/discordKnowledge.js`): only in the owner's
servers (`OWNER_GUILD_IDS`), only in text and announcement channels `@everyone` can read (with their
history), and nobody else's. The worker hosting the owner's server reads each such channel's history
back to its start once, 100 messages a request, one request every `DISCORD_HISTORY_DELAY_MS`
(default 1000); where it got to is kept in `discord_backfill`, so a restart goes on from there. New,
edited and deleted messages are followed after that (a deleted one leaves the knowledge). Messages
are stored in `discord_posts` (channel and author names once each in `discord_channels` and
`discord_users`), and each account's messages of a month become one page of the knowledge tables
as source `discord` (one line per message with its date, channel
and link), so knowledge is taken out of them and they are searched with `search_wiki` together with
the wiki and the X posts; the model gives a message's link when it mentions one. Threads are not read.

With `KNOWLEDGE_TOPICS` set (comma-separated or one per line, each with what it is, e.g.
`ぽみそしる（のばまんが所属する実況者グループ）`), topics the wiki and the posts say little about are
looked up on the web (`src/bot/modules/webKnowledge.js`): Gemini searches each with Google Search
once every `WEB_REFRESH_HOURS` (default 168) and sums up what it found (members, when it started,
what it does, official links) with its sources and the date. That is stored in the knowledge tables as
source `web`, its knowledge taken out and searched with `search_wiki` like the rest;
the model says it is what was found as of that date, not certain fact.

Each emoji is described once from its image and name by Gemini (what it shows, when to use it) and
stored with an embedding of that description in `guild_emojis` (`src/bot/modules/emojiDescriber.js`).
When the wiki describes characters (pages whose title has キャラクター), Gemini is given them, so an
emoji of a character is named; when what the wiki says about them changes, the emojis are described
again.
Each worker does this in the background for the servers it hosts, at startup and when a server's
emojis change; a renamed emoji is described again. The profile then lists each emoji with its
description, those closest in meaning to the request first. `EMOJI_DESCRIPTIONS=false` turns it off.

How much each user may use mentions is counted in Gemini tokens in Redis
(`src/bot/utils/mentionQuota.js`), like Claude's usage limits: per user across every server, in a
five-hour window (`MENTION_TOKEN_LIMIT_5H`, default 150,000) and a week (`MENTION_TOKEN_LIMIT_WEEK`,
default 750,000; about what Claude's free plan allows), each starting with the user's first use. Every Gemini call made for a mention
counts once it is answered, by what it cost on Gemini's price list (`src/bot/utils/geminiPrices.js`:
each model's input, cached input, answer and image prices, Flex half), counted in tokens of Gemini
3.8 Flash's input ($0.75 a million): 150,000 is about $0.11 of Gemini and 750,000 about $0.56, so
a Gemini 4 Argon token ($2 in, $10 out) counts for more than a Flash one; at a limit the user is
told when it resets. A server can have its own limits (`%tokenlimit`): use is still counted across every server and measured against the limits of the server the mention is in. Before a limit is reached use slows down instead: past `MENTION_FLEX_AT_PERCENT` (default 95) of either window every Gemini call of the user's mentions goes to Flex inference (half the price, queued for up to minutes) and they are told so; a server can set its own share. The bot's developers (`CREATOR_IDS`) have none. Outside the owner's servers
(`OWNER_GUILD_IDS`) the whole server also has 30 mentions a day, Japan time
(`MENTION_GUILD_DAILY_LIMIT_OTHER`). If Redis is unreachable the mention goes through.

Everything the bot does with AI in the background (video and archive summaries, emoji descriptions,
stream blurbs) goes through one queue per worker (`src/bot/utils/backgroundQueue.js`,
`AI_BACKGROUND_CONCURRENCY` at a time), where the owner's servers always go first; other servers'
work waits until none of theirs is waiting. A stream blurb for another server that does not get its
turn within a minute is left out rather than holding up the event. Message and video embeddings,
YouTube syncs, stream checks and emoji descriptions also take the owner's servers first.

Drafting is a Gemini function-calling loop (`src/bot/modules/eventDrafter.js`) over read-only tools
(`src/bot/modules/eventTools.js`): fetch a web page, read a Discord message by link, read a channel's
recent messages, list channels, list forums with their tags and guidelines, and list existing
scheduled events. The model ends by submitting an event or a forum post draft, which is checked
against Discord's limits (`toScheduledEvent`, `src/bot/modules/forumPost.js`). When something can't be decided
from those (several candidate events, an ambiguous date, event or forum post), the model asks the requester with up to 4
buttons plus a way to stop, at most 3 times per draft. Discord reads are limited to this
server and to channels both the requester and the app can read, so a mention can't reveal a channel
the requester couldn't open. Web pages are fetched by the app itself; private and loopback addresses
are refused.

Every request also carries a profile of the server, fetched fresh each time: its name and
description, the channels the requester can see (with their topics, grouped by category, the request
channel marked with its ID), role names, scheduled events, and whether a YouTube channel is stored.
Questions about "this channel" are answered from the stored message history: the
`search_channel_history` tool reads a channel's stored messages (up to the newest 1000, optionally
narrowed by words) for channels both the requester and the app can read, and sends the matching text
to Gemini. This is the same `messages` table the deletion and edit logs use, so it covers only servers
with such a log channel, only messages stored since the channel/server columns were added (older rows
have no channel), and only within `MESSAGE_HISTORY_DAYS`. `get_recent_messages` still reads the latest
messages straight from Discord when nothing is stored.

### What each server is like (`SERVER_LORE`)

Off by default. With `SERVER_LORE=true` the assistant learns each server it is in, so it talks as one
of its own there:

- **Running jokes, words and happenings.** Once a day, the worker hosting the server reads its stored
  messages (the same `messages` table the logs use, so only servers with a message log) in text and
  announcement channels `@everyone` can read, one chunk per channel and week for the last
  `SERVER_LORE_WEEKS` weeks (default 8; weeks with fewer than 15 messages are skipped, bots' messages
  are left out). Gemini takes out running jokes, words and nicknames, happenings and topics, told to
  leave out personal information and judgements of anyone. A chunk is read again only when its
  messages changed (an edit, a deletion, `/clearmydata`), and a chunk out of the window goes, so
  what is kept follows what is stored. Stored in `guild_lore_chunks` / `guild_lore_facts`, embedded.
- **How the server talks.** From the latest messages of those channels, a short description of the
  server's tone (wording, endings, how hard the jokes land), refreshed weekly at most, in
  `guild_lore_style`. Nothing about a single member is written.
- In the server profile sent with a request: the style, and up to five pieces of the server's
  knowledge close in meaning to the request (drawn at random among the close ones). With
  `MESSAGE_EMBEDDINGS=true` also up to five past messages close to the request, from channels the
  requester and the app can read.
- **Members are looked up only when asked about**, with the `about_member` tool: display name, roles,
  join date, and their latest stored messages (up to 30) in channels the requester and the app can
  read. Nothing is kept from it. Without `SERVER_LORE` the tool returns only what Discord shows (no
  messages).

This uses the stored log messages for something the Privacy Policy and the privileged intent answers
do not declare yet. Update them before turning it on
(see [`docs/discord/privileged-intent-review.md`](docs/discord/privileged-intent-review.md) §9).

### YouTube knowledge

The YouTube channels are the bot's, the same for every server: `YOUTUBE_CHANNELS` names them
(comma-separated `@handle`, channel URL or `UC…` ID; default のばまんゲームス, `UCTW2tw0Mhho72MojB1L48IQ`, and のばまん・ロー・エフォート, `UCz7pNw3UkTF9WQjHcYpFD9g`).
At startup the worker owning shard 0 resolves every one (if one cannot be, nothing changes) and
follows exactly those: a channel added is read from the start, one removed goes with its videos.
That worker also keeps them synced. `/youtube show` shows them in any server, and `/youtube sync`
(from the owner's servers) reads them again. Each server still chooses for itself whether their
streams and uploads become its events (`/youtube liveevents`). Knowledge accumulates:

- The first read walks the channel's whole upload list (up to 5000 videos, 2 quota units per 50).
  Later reads stop at the first page of already-stored videos, so they cost 3 units unless much is
  new, while the newest page is always re-read to catch streams that went live or ended.
- Videos are added or refreshed, never dropped while the bot follows the channel.
- Each video keeps its title, description, publish date, length and stream state and time
  (`YOUTUBE_API_KEY`, YouTube Data API).
- A summary lists the topics in order, each with the time it starts (`[12:34]`). Wherever a summary
  is shown to the model or in `/youtube summarize`, those times are links that open the video there
  (`&t=754s`), and the model is told to give a video's URL, and the link to the moment, whenever it
  mentions one. Summaries made before this have no times; `force:True` makes them again.
- What a video actually says is summarized only when needed: when a video link is given or the
  question is about a video's contents, the model calls `summarize_youtube_video`, which hands the
  public video's URL to Gemini (low media resolution) and stores the summary. Gemini answers only
  when it has watched the whole video, so this waits up to `VIDEO_SUMMARY_TIMEOUT_MINUTES` (default
  10) and the reply shows that a video is being read. Past 5 minutes that needs its own undici
  dispatcher, since `fetch` otherwise gives up on a response that has not started by then. The same video is never
  summarized twice for a server; summaries of videos from other channels are kept as well.
- `/youtube summarize count:<1-50>` summarizes the newest stored videos that have no summary yet
  (default 3, streams that are live or upcoming skipped; `force:True` takes the newest whether or not
  they have one and replaces the stored summary; `url:<video link>` summarizes that one video, from
  any public channel and without a channel set, and shows the summary), one at a time, showing progress. A long
  run can outlast the 15 minutes an interaction can be edited; the result is then posted in the
  channel.
- New videos are picked up automatically (`src/bot/modules/youtubeSync.js`). With YouTube pushes
  set up (`YOUTUBE_WEBSUB_URL`, see "Streams as server events"), a channel is synced when YouTube
  pushes an upload, a new stream or an edit, and there is no timed sync. Without them, every
  `YOUTUBE_AUTO_SYNC_MINUTES` (default 15, 0 turns it off) each worker checks the servers it hosts:
  the channel's public feed (`/feeds/videos.xml`, no API quota) shows whether there is a video not
  stored yet, and only then is the channel synced. A server with a live or upcoming stream, or with
  older videos left from a first read, is synced on every check, so stream states stay current.

### Streams as server events

`/youtube liveevents enabled:True` (Manage Server; the bot needs Manage Events) makes the server's
YouTube streams scheduled events (`src/bot/modules/liveWatcher.js`), and new uploads too: an
ordinary video seen in the channel's feed within `UPLOAD_EVENT_MAX_AGE_HOURS` (default 6) of its
upload becomes a "📺 新着動画" event, started at once with its description, link and thumbnail, and
ended after `UPLOAD_EVENT_HOURS` (default 24); `UPLOAD_EVENTS=false` turns that off. Shorts (videos at most `UPLOAD_EVENT_SHORTS_SECONDS` long, default 180) get no event. Each stream's event follows it: made when the stream is scheduled, with its title,
description, link and thumbnail as the cover (an unscheduled stream gets one when it starts, started
straight away); moved when the start time changes; started when the stream goes live; kept open past
its planned end while it runs; completed when it ends, or cancelled if the stream is called off or
deleted. An event someone deletes is left alone.

With AI Gateway set up, the event's description starts with two or three sentences from Gemini on
what the stream is about, made from its title, description and thumbnail (a stream can't be watched
while it is live). For a game stream, Gemini also names the games played, and each gets a
line with its page (`src/bot/modules/gameLinks.js`): its Steam store page when Steam's own search
has a game of exactly that name (Japanese, then English), else an official page (the game's site, or
its PlayStation, Nintendo, Xbox or app store page) Gemini finds with Google Search, kept only once
the page has been read. `GAME_LINKS=false` leaves the game pages out. Once a stream is over, its archive is summarized like any video, so the mention
assistant knows what was said; this is tried 30 minutes after it ends, then hourly, three times at
most, on the worker hosting the server, one at a time. Each summary is one Gemini call on the whole
archive. `LIVE_EVENT_AI_DESCRIPTION=false` and `LIVE_ARCHIVE_SUMMARY=false` turn these off.

Discord game mentions (`<@$APPLICATION_ID>`, what typing "@game Palworld" makes in the app) show a
game's Discord profile. `src/bot/modules/gameMentions.js` finds a game's ID by name in Discord's
public list of the games it knows (`GET /applications/detectable`, read once a day), other names
included. In chat the model looks a game up with `find_game` and writes its mention as it is,
with its page. In a stream's event they are left out unless `EVENT_GAME_MENTIONS=true`, since an
event's description may show the code rather than the game.

Each worker checks the servers it hosts every `YOUTUBE_LIVE_POLL_SECONDS` (default 60, 0 is off).
A check reads the channel's public feed (no API quota) and asks the API only about new entries and
streams already upcoming or live (1 unit per 50), so a scheduled stream is followed for about 1,440
units a day at most.

With `YOUTUBE_WEBSUB_URL` and `YOUTUBE_WEBSUB_SECRET` set, YouTube also pushes new uploads and
streams (`src/miscellaneous/websub.js`, WebSub): the master process listens on `PORT` at
`/youtube/websub`, subscribes every configured channel at Google's hub (renewing before the 5-day
lease ends, checked hourly), verifies the hub's HMAC signature, and has the workers check that
channel at once; every server with that channel is synced too. On Railway, generate a public domain for the service and set
`YOUTUBE_WEBSUB_URL=https://<domain>`. A stream going live is not always pushed, which the poll
covers.

### Search by meaning

YouTube videos (title, description and summary) and, with `MESSAGE_EMBEDDINGS=true`, every stored
message get an embedding from Gemini's embedding model (`GEMINI_EMBEDDING_MODEL`, default
`gemini-embedding-001`, through AI Gateway), so `search_youtube`, `search_channel_history` and
`search_server_messages` (all channels the requester can read; offered only with message
embeddings) find things worded differently ("怖いゲーム" finds a video titled "ホラー"). A result
that contains every word of the query still comes first.

- Vectors (512 dimensions) are stored as pgvector `halfvec` columns with an HNSW index, and
  Postgres finds the nearest ones (`src/db/interfaces/postgres/embeddings.js`). The database needs
  the pgvector extension, 0.7 or later (0.8 or later for complete results when a search is limited
  to some channels; older versions scan exactly instead). Migration 009 enables it and converts
  the vectors stored before.
- `src/bot/modules/embeddingIndexer.js` runs on the worker owning shard 0 every
  `EMBEDDING_INTERVAL_MINUTES` (default 5, 0 is off): videos whose text changed, then up to 1000
  messages not embedded yet, newest first. A large history is worked through over many runs.
- Gemini API embedding models work: `gemini-embedding-001` (default, text, purpose given as
  `taskType`) and `gemini-embedding-2` (newer, purpose given as a text prefix since it takes no
  `taskType`).
- Each vector records the model that made it, and only vectors of the current model are compared.
  Changing `GEMINI_EMBEDDING_MODEL` makes everything again on the following runs (videos at once,
  messages up to 1000 a run); meanwhile search uses what has been redone.
- A message's embedding is a column of its row (`messages.embedding`, with the model in
  `embedding_model_id`; a video's likewise on `youtube_videos`), so it goes whenever the message is
  deleted (retention, `/clearmydata`, leaving a server), and an edit clears it to be made again.
  Messages stored before channels were recorded are not embedded.
- With message embeddings on, **every stored message is sent to Google Gemini** to be embedded, not
  only mentions. Update the Privacy Policy and the privileged intent answers before turning it on.

The system instructions and tools of a mention, the same for every request, are kept in an explicit
Gemini cache (`cachedContents`, an hour at a time, renewed as used) and referred to by name, so each
round trip bills them at the cached rate; Gemini's own implicit cache only takes prompts starting with
4,096 identical tokens, about their size, and rarely hit. When a cache cannot be made (too small for
the model, an old model) requests go in full as before. The last step, limited to submitting, has its
own tool settings and always goes in full.

A cache is made for exactly the instructions and tools it holds, so changed instructions always get a
new one. Each is labelled with the version of the instructions (`robopolice-mention:<hash>`), and the
first cache a worker makes for a new version deletes this bot's caches of every other version on
Gemini's side rather than leaving them until they expire. Caches without that label (other apps on the
same key, or made before the label existed) are not touched.

Every Gemini call goes through Cloudflare AI Gateway. The tokens each kind of call uses (prompt, of it served from Gemini's cache, answer and thinking, by purpose and model) are logged once an hour (`[GEMINI]: Tokens in the last hour`), to see where the cost goes. YouTube Data API calls can too: in the
dashboard, add a custom provider (AI Gateway → Custom Providers) with base URL
`https://www.googleapis.com` and a slug such as `youtube`, then set `YOUTUBE_GATEWAY_PROVIDER=youtube`.
Requests then go to `…/custom-youtube/youtube/v3/…` with the gateway token. Either way the API key is
sent in the `x-goog-api-key` header, never in the URL.

The model searches all of it (titles, descriptions and summaries) with the `search_youtube` tool.

### Prompt injection

Text the app did not write can carry instructions aimed at the model ("ignore your instructions…").
The model can only read (every tool is read-only and limited to what the requester can see), and
nothing is posted or registered until the requester presses the button, so the damage is bounded;
on top of that (`src/bot/utils/untrusted.js`, `linkSafety.js`):

- Everything the app did not write goes to Gemini inside `<untrusted source="…">…</untrusted>`: the
  request, the conversation it replies to, the server profile and every
  tool result. The tag cannot be closed from inside. The system instructions say such text is data,
  never instructions, and not to reveal the instructions themselves.
- A chat reply keeps only links that came up in the conversation (the request, what it replies to,
  what a tool read); others are left as plain text. A link whose text names another site shows
  where it really goes.
- Knowledge taken out of the wiki, X, Discord, the web and the servers' messages leaves out
  instructions to the bot, so nothing planted there stays in later prompts.
- The usual wording of an attempt is logged (`[INJECTION]: …`), in mentions, what they reply to and
  tool results. Nothing is refused on it alone.

What the tools read (the mention, the replied-to message, linked pages and Discord messages, the
server profile, stored YouTube data) is sent to Google Gemini through Cloudflare AI Gateway. Nothing
from this flow is stored by the app. Use a paid Gemini API tier: on the free tier Google may use the input to improve its models,
which the intent review answers rule out.

The preview has Register / Post, **内容を修正** (fix the text) and Cancel buttons. 内容を修正 is about
the draft itself (name, time, place and description; or title, body, tags and forum), not the image,
and asks the requester to type what to change as their next message in the channel; the correction goes back to the model, which revises
its own draft (up to 3 times). Questions the model asks can likewise be answered in words with
"その他（文字で入力）". A forum mentioned in the request (`@RoboPolice #募集 に立てて`) is always the
one posted to.

A correction changes the text only. The image stays as the requester left it: new candidates the
correction brings are added to the list without being selected, and an AI image is not redrawn
(the preview says so; "画像: AIで作り直す" makes a new one).

What the bot made can be changed later (`src/bot/modules/postedEdit.js`): reply with a mention to the
"イベントを登録しました / フォーラムに投稿しました" message, or to the forum post itself, and say what to
change (`@RoboPolice 開始を20時に`). The model gets the present content and changes only what was
asked; the preview lists the changed fields and an **更新する** button updates the event or post in
place (a forum post stays in its forum). The image is kept unless another is picked. Only events
and posts the bot made can be changed, with the same permissions it takes to make them, and
finished or cancelled events can't.

The model can also propose images for the event cover or the forum post, up to 4 best first: the
`og:image` / `twitter:image` of pages it read, images attached to the mention or the replied-to
message, or embed images. The app downloads them (same address checks as pages, images only, 10MB at
most). With more than one, the preview shows them side by side ("画像の候補", the selected one framed
in yellow) with a row of 画像1…画像4 buttons to pick one. The preview shows the actual result, 800×320
for an event cover or 1280×720 for a forum post, and one more row of buttons switches how it is made
(`src/bot/modules/coverImage.js`):

| Mode | What it does | Default for |
|---|---|---|
| 切り抜き | Crops with sharp's attention strategy, keeping the most salient region | Images close to the target shape (photos) |
| 全体表示 | Shows the whole image over a blurred, darkened copy of itself | Posters and anything far from the target shape |
| AIで作成 | Gemini's image model (`GEMINI_IMAGE_MODEL`) makes a new cover from the title and description, based on the selected image if there is one, without text | — |
| なし | No image | Drafts without an image |

"AIで作成" sends the title, description and the selected image to Gemini, the same way drafting does.
Images that can't be used are left out of the candidates, the draft still works, and the preview says why.

The image can also be changed in words. **画像を指示で変更** asks what to do with it: an image URL or
an attached image replaces it (as a new candidate, selected), anything else ("背景を夜空にして",
"もっと明るく") has Gemini's image model edit the image shown now, or make one when there is none.
Further instructions edit the edited image, and "画像: AIで編集" switches back to it after trying
another mode. The model also passes on an instruction about the image found in the request or a
correction (`image_instruction`), so `@RoboPolice 画像を夕焼けにして` replying to a post the bot made
edits that post's image, and an image attached to such a reply (with or without text) replaces it.
Up to 5 image instructions per draft.

One mention usually takes 2-4 Gemini requests (one per tool step, up to 10), plus one per
correction, AI-made image or video summary; each mention logs how many it used. HTTP 429 is retried
up to 3 times (Retry-After, else 2s, 4s, 8s), telling the requester it is waiting. A 429 from AI
Gateway itself (`AiGatewayError`, code 2003) comes from the gateway's Rate-limiting setting, which
counts requests, not tokens: allow something like 30 requests per 60 seconds.

If drafting fails, the reply shows the cause and the top of the error log so staff can tell what
went wrong without server access. Secrets are masked first (`src/bot/utils/redact.js`): values of
environment variables whose names look secret (`*TOKEN*`, `*KEY*`, `*PASSWORD*`, webhook URLs, the
Cloudflare account ID) and patterns such as Discord tokens, Google API keys, bearer tokens and
credentials in URLs. The same masked text goes to the error webhook.

## Requirements

- PostgreSQL 11+
- Redis
- Node.js 18+

## Setup

1. Set up Postgres with a superuser (the default user works)
2. Clone the repo and enter the folder
3. `cp .env.example .env` and fill it in. Every value is required except the ones marked optional
4. `npm install`
5. `node src/miscellaneous/generateDB.js` to create the database and its tables
6. `node index.js`
7. Register slash commands with the text prefix: `%setcmd global` for global commands, or
   `%setcmd guild` for faster server-scoped registration (substitute your `GLOBAL_BOT_PREFIX`)

## Database migrations

The schema is kept in `src/db/migrations`: numbered files, applied in order, each once, recorded in
`schema_migrations`. The app applies the ones not applied yet when it starts, before any worker
connects to Discord, so an update needs no manual step; `npm run migrate` applies them by hand. An
existing database, whatever it already had, is brought up to date the same way: the first migration
only creates what is missing.

Take a backup before the first start with migrations (`pg_dump`). Migration 002 to 005 change the
layout: settings, image URLs and YouTube data move to their own tables and the old columns are
dropped, so going back to an older version needs the backup.

Everything stored for a server refers to its `guilds` row with a foreign key, so it is all
deleted when the app leaves the server. `%reset` clears only the settings.

Messages stored before channels were recorded have no `channel_id` and `guild_id`, so channel
history and message search never find them. The bot fills them in once, in the background after
it starts: it reads every channel and thread of each server back to the oldest such message (100
messages a request, one request every 250 ms, waiting out rate limits) and matches IDs. Messages no
longer on Discord stay unknown. When it has finished, Redis records it (`backfill-channels:done`)
and it does not run again; if it stops on an error, it tries again at the next start.
`BACKFILL_CHANNELS=false` turns it off; `npm run backfill-channels` runs it by hand.

A change to the schema is a new file (`NNN_name.sql`, or `NNN_name.js` exporting
`async client => {}` for data SQL alone can't change); a file already applied is never edited.
`npm run test:db` runs the migrations and the stores against a scratch database on the Postgres
that `PGHOST`, `PGUSER` and `PGPASSWORD` point at.

## Cloudflare: AI Gateway and Access

The Terraform in `infra/cloudflare` manages the AI Gateway and the Cloudflare Access application
and policies in front of its custom domain (only the bot's service token, and the people listed,
get through). The service token and the custom domain are made in the dashboard; see
[`infra/cloudflare/README.md`](infra/cloudflare/README.md).

## Running on GKE

To run it on the wax100 GKE platform ([waxsd100/k8s-platform](https://github.com/waxsd100/k8s-platform):
Canine for dev, promoted to production with GitOps) instead of Railway, including moving the
Railway database over, follow [`docs/deploy/gke.md`](docs/deploy/gke.md). There the secrets come from
Secret Manager through External Secrets, so `GCP_SECRETS` and the service account key below are not
used. The bot must run as **one** replica: two connected with the same token log and reply twice.

## Secrets in Google Cloud Secret Manager

Secrets can live in Secret Manager instead of on the hosting platform, which then holds only a key
for a service account that can read nothing but those secrets. At startup the app reads them into
the environment (`src/miscellaneous/secrets.js`) before anything else starts; without
`GCP_SECRETS` it uses the environment as it is. The Terraform in `infra/terraform` creates the
secrets, the service account and its access. Secret values are added with `gcloud`, so they never
reach Terraform state.

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # set project_id, and secret_names to the variables you use
terraform init
terraform apply
```

By default this moves only what would do real damage if it leaked: `BOT_TOKEN`,
`CLOUDFLARE_AI_GATEWAY_TOKEN`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `YOUTUBE_API_KEY`. Everything else stays on Railway, including the database and Redis
passwords it creates for its own Postgres and Redis; add more to `secret_names` as needed. Secret
Manager has no folders, so the secrets are named `robopolice-…` (`secret_id_prefix`) and labeled
`app=robopolice`: `gcloud secrets list --filter="labels.app=robopolice"` lists them.

Then store the values (each command reads the value from a shell variable of the same name; load
your current `.env` first with `set -a; . ../../.env; set +a`):

```bash
terraform output -json add_value_commands | jq -r '.[]' | sh
```

Create the key and set the two variables on the hosting platform:

```bash
gcloud iam service-accounts keys create robopolice-key.json --iam-account "$(terraform output -raw service_account_email)"
base64 -w0 robopolice-key.json   # -> GCP_SERVICE_ACCOUNT_KEY
terraform output -raw gcp_secrets # -> GCP_SECRETS
rm robopolice-key.json
```

Every listed secret needs a value: one without a version stops the app at startup, saying which.
Finally remove the moved variables from the platform. One that is still set there wins over Secret
Manager, and the app logs a warning naming it. Changing a secret is `gcloud secrets versions add`
and a restart. If the organization blocks service account keys
(`iam.disableServiceAccountKeyCreation`), allow them for this project first. The key can still read
the secrets if it leaks, so keep it only on the platform and delete it in the console
(or `gcloud iam service-accounts keys delete`) to cut access at once.

## Configuration worth knowing

| Variable | Effect |
|---|---|
| `MESSAGE_HISTORY_DAYS` | Retention window. Unset (or 0/non-numeric) means retention is unlimited by design — nothing is ever pruned, and `/help`/`/clearmydata` say so instead of naming a day count. The bot logs which mode it's in at startup. If you go unlimited on a real deployment, update the Privacy Policy's retention section to match, since it currently states a fixed number of days. |
| `CREATOR_IDS` | Optional. The bot's developers (Discord user IDs, comma-separated). They can use the developer commands (`%eval`, `%setcmd`, …) and bypass every permission check a member's own permissions could pass, in every server: prefix commands, the permissions slash commands ask of the user, Manage Events for a mention event, and posting in a forum. Not what the bot itself needs |
| `STAFF_ROLE_ID` | Optional. A member holding this role, or any role at or above it in Settings > Roles, bypasses the same permission checks a server owner already bypasses — not creator-only commands, and not what the bot itself needs. Unset disables it entirely. |
| `PRUNE_EXTERNAL` | Set `true` only when running `prune.js` as a separate cron service, so the bot stops scheduling its own sweep |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID` | Enable drafting events and forum posts from mentions. Unset means mentions are ignored (unless `CLOUDFLARE_AI_GATEWAY_URL` is set) |
| `CLOUDFLARE_AI_GATEWAY_URL` | Optional. The gateway's custom domain (e.g. `https://ai-gateway.example.com`); requests go to `<domain>/<provider>/…` instead of `gateway.ai.cloudflare.com/v1/<account>/<gateway>/…`, and the two IDs above are not needed |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | Optional. A Cloudflare Access service token, sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, for a gateway domain behind Access (Zero Trust). Keep the secret in Secret Manager |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Optional. Sent as `cf-aig-authorization` for an authenticated gateway |
| `CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS` | Optional. Name of the Gemini key stored in the gateway (BYOK), sent as `cf-aig-byok-alias`. Unset uses the key named `default` |
| `GEMINI_API_KEY` | Optional when the key is stored in the gateway (BYOK); otherwise required for drafting from mentions |
| `BOT_MODEL_NAME` | Optional (default `nobaman llm 3.9 Flash`). What the bot says its model is when asked. The debug line under replies (`%debugfooter`) still names the real models |
| `GEMINI_MODEL` | Optional. Defaults to `gemini-3.8-flash` (a fixed model rather than the `gemini-flash-latest` alias, so a cache is made for a known model and a new model is a choice) |
| `GEMINI_THINKING_LEVEL` | Optional (default `high`; `minimal`, `low`, `medium` or `high`). How much Gemini 3 thinks before a mention reply or draft, billed as answer tokens. Not sent to older models |
| `GEMINI_DEEP_MODEL` | Optional (default `gemini-4-argon`). The stronger model a mention is handed over to when it needs much reasoning or a long text: the reply model calls `think_deeper` first, and this model answers from the request on (it has no explicit cache, so requests go in full). Empty to turn it off |
| `GEMINI_DEEP_FLEX` | Optional (default on). `false` asks `GEMINI_DEEP_MODEL` at the standard tier instead of Flex inference (half the price, but queued for up to about 15 minutes; the requester sees that it is thinking) |
| `GEMINI_DEEP_FLEX_FALLBACK` | Optional (default off). Without Flex capacity (HTTP 429/503 after retries, or 524) the stronger model is not asked at the standard tier: the usual reply model answers instead, and the line under the reply says so (`Flex unavailable`). A video summary asked on Flex fails. `true` sends the request once at the standard tier, at the standard price |
| `GEMINI_FLEX` | Optional (default on). `false` never asks for Flex inference (the stronger model, a command's newest or short video summaries), asking at the standard tier instead. A Flex request says nothing while it is queued (minutes), and through `CLOUDFLARE_AI_GATEWAY_URL` Cloudflare gives up after 100 seconds (HTTP 524), so Flex requests go to the gateway's default endpoint (`gateway.ai.cloudflare.com`), which needs `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` even with a custom domain |
| `GEMINI_STREAM` | Optional (default on). Mention replies and drafts are asked as `streamGenerateContent`, with the model's thought summaries on, so bytes keep coming while it thinks: Cloudflare gives up on a response that has not started within 100 seconds (HTTP 524). The thought summaries are left out of the answer. `false` asks in one piece |
| `GEMINI_DEEP_THINKING_LEVEL` | Optional (default `high`). How much `GEMINI_DEEP_MODEL` thinks |
| `VIDEO_SUMMARY_THINKING_LEVEL` | Optional (default `low`). The same for video summaries, which need little thinking |
| `GEMINI_LIGHT_THINKING_LEVEL` | Optional (default `low`). The same for work in the background (knowledge, emoji descriptions, blurbs, game links, server knowledge) |
| `GEMINI_EXPLICIT_CACHE` | Optional. `false` stops caching the system instructions and tools (see below) |
| `GEMINI_LIGHT_MODEL` | Optional (default `gemini-3.5-flash-lite`). The cheaper model for work in the background: taking knowledge out of the wiki, X and web pages and the servers' messages (`SERVER_LORE`), describing emojis, stream blurbs, game links, and putting a long video's parts together. Empty to use `GEMINI_MODEL` for everything. Mention replies and video summaries use `GEMINI_MODEL` |
| `VIDEO_SUMMARY_FPS` | Optional (default `0.2`, one frame every 5 seconds; Gemini's own default is 1). Frames a second Gemini looks at when summarizing a video. Each frame costs tokens while the sound is heard throughout, so fewer frames cost much less |
| `GEMINI_TEMPERATURE` | Optional (default `1`, 0–2; Gemini 3 is tuned for 1 and may loop below it). How varied mention replies and drafts are; higher is more varied. Drafts are checked field by field either way |
| `GEMINI_REPLY_TIMEOUT_SECONDS` | Optional (default `180`). How long one Gemini round trip of a mention reply or draft may take before it is given up (`GEMINI_DEEP_MODEL` has its own 20 minutes) |
| `MENTION_RECENT_TOPICS`, `MENTION_RECENT_MESSAGES`, `MENTION_RECENT_HOURS` | Optional. The recent messages of the channel that bear on a request go with it: from the last 50 (at most 100) of the past 12 hours by default. `MENTION_RECENT_TOPICS=false` turns it off |
| `REPLY_POLISH` | Optional (default on). Mention chat replies are rewritten once by `GEMINI_LIGHT_MODEL` with [yomiyasu-pocket](https://github.com/nanaism/yomiyasu-pocket) (MIT, kept in `vendor/yomiyasu-pocket`) to read less like AI-made Japanese, keeping what they say, their tone, mentions, emojis, links and code. Not replies of `GEMINI_DEEP_MODEL` (stories and long writing), nor ones under 40 characters; a rewrite that drops a mention, link or code or changes the length by half is not used. A daily workflow (`yomiyasu-update.yml`) opens a pull request when yomiyasu-pocket has a new release. `false` turns it off |
| `GEMINI_MAX_STEPS` | Optional (default `20`). How many Gemini round trips a reply or draft may take (each lookup is one); the last one may only answer with what was found |
| `YOUTUBE_API_KEY` | Optional. YouTube Data API v3 key for `/youtube`. Unset disables the command |
| `VIDEO_SUMMARY_TIMEOUT_MINUTES` | Optional. How long a video summary may take. Defaults to 10 |
| `WIKI_URLS` | Optional (default `https://novamanhikoushiki.memo.wiki/`; empty turns it off). Top pages of the community's wikis (comma-separated), e.g. `https://novamanhikoushiki.memo.wiki/`. Read in full weekly, split at headings and embedded; the model searches them with `search_wiki` (characters, quotes, running jokes), and emoji descriptions name the characters they describe |
| `WIKI_REFRESH_HOURS`, `WIKI_DELAY_MS` | Optional. How often a wiki is read again (default 168) and the wait between its pages (default 1000) |
| `TWITTER_ACCOUNTS` | Optional (default `nobamangames`; empty turns it off). The streamer's X accounts (comma-separated, without @), e.g. `nobamangames`. Their posts are read through FxTwitter and become knowledge like the wiki (searched with `search_wiki`) |
| `TWITTER_REFRESH_HOURS`, `TWITTER_MAX_PAGES` | Optional. How often new posts are read (default 6) and how many pages back the first read goes (default 100, about 10 posts a page) |
| `DISCORD_KNOWLEDGE_USERS` | Optional (default `615170548187791365`, のばまん; empty turns it off). User IDs (comma-separated) whose own messages in the owner's servers' `@everyone` channels become knowledge, e.g. the streamer's account. Their past messages are read once, then new ones are followed |
| `DISCORD_HISTORY_DELAY_MS` | Optional. Wait between history requests when reading past messages (default 1000) |
| `KNOWLEDGE_TOPICS` | Optional (default ぽみそしる and トマスコ, see `src/bot/utils/knowledgeDefaults.js`; empty turns it off). Topics to look up on the web with Gemini's Google Search and keep as knowledge (comma-separated or one per line), e.g. `ぽみそしる（のばまんが所属する実況者グループ）,トマスコ（トマトスコスコ人生、のばまんが所属するユニット）` |
| `WEB_REFRESH_HOURS` | Optional. How often each topic is looked up again (default 168) |
| `OWNER_GUILD_IDS` | Optional. The owner's servers (comma-separated), default `615170683068219393`. They have no per-server mention cap and go first in all background AI work; every other server waits for them |
| `MENTION_TOKEN_LIMIT_5H`, `MENTION_TOKEN_LIMIT_WEEK` | Optional. Gemini tokens each user may use for mentions across every server, in five hours (default 150,000) and a week (default 750,000) from their first use; cached prompt tokens count at a tenth. 0 turns one off |
| `MENTION_TOKEN_PRICES` | Optional. Prices of models not in `src/bot/utils/geminiPrices.js` (or new prices), in USD per million tokens, as JSON: `{"gemini-5-flash": {"input": 1, "cached": 0.1, "output": 5}}`. A model with no price counts as Gemini 3.8 Flash |
| `GEMINI_HOURLY_BUDGET` | Optional (default 2,000,000, about $1.50 an hour of Gemini; in the tokens of the user limits). How busy the bot is as a whole: what every Gemini call cost in the past hour, across workers (Redis), against this. From `GEMINI_LOAD_MEDIUM_AT` (default 50%) mention replies think at medium at most; from `GEMINI_LOAD_FLEX_AT` (default 80%) at low, and every generation, replies and background work alike, goes to Flex inference (image models aside). `0` turns it off |
| `MENTION_FLEX_AT_PERCENT` | Optional (default 95). Past this share of either token window, every Gemini call of a user's mentions goes to Flex inference (slower, half the price); a server can set its own (`%tokenlimit flex`). 0 never |
| `MENTION_GUILD_DAILY_LIMIT_OTHER` | Optional. Mentions a day for a whole server other than the owner's (default 30); 0 turns it off |
| `AI_BACKGROUND_CONCURRENCY` | Optional. How many background AI jobs (video and archive summaries, emoji descriptions, stream blurbs) run at once on a worker (default 3) |
| `EVENT_GAME_MENTIONS` | Optional. `true` puts each game's Discord game mention in a stream's event too (off by default: check that your server's events show it as the game) |
| `GAME_LINKS` | Optional. `false` leaves out the pages (Steam or official) of the games a stream's event names |
| `EMOJI_DESCRIPTIONS` | Optional. `false` stops describing the server's custom emojis (Gemini looks at each one's image and name; the descriptions are embedded so the emojis that suit a request are offered first) |
| `LIVE_EVENT_AI_DESCRIPTION` | Optional. `false` stops the AI's line on what a stream is about (from its title, description and thumbnail) at the top of its Discord event |
| `LIVE_ARCHIVE_SUMMARY` | Optional. `false` stops summarizing a stream's archive once it is over (tried 30 minutes after it ends, then hourly, three times at most) |
| `VIDEO_SUMMARY_CONCURRENCY` | Optional. How many videos `/youtube summarize` summarizes at once (1-10). Defaults to 3 |
| `VIDEO_SUMMARY_BATCH` | Optional (default on). `/youtube summarize` sends the videos to Gemini's Batch API: half the price, done within 24 hours (usually much sooner); the summaries are stored and the channel is told when the batch is done (it is checked every 5 minutes, and survives restarts). A video too long for one request is then summarized in parts the usual way. `false` summarizes right away instead. Summaries the model asks for during a mention are always made right away |
| `VIDEO_SUMMARY_FLEX_SECONDS` | Optional (default `300`). With `VIDEO_SUMMARY_BATCH` on, `/youtube summarize` does not batch each channel's newest video nor videos at most this many seconds long (Shorts, clips): they are summarized at once on Flex inference (half the price as well, queued for minutes at most; at the standard tier when Flex has no room) |
| `YOUTUBE_CHANNELS` | Optional (default `UCTW2tw0Mhho72MojB1L48IQ,UCz7pNw3UkTF9WQjHcYpFD9g`, のばまんゲームス and のばまん・ロー・エフォート; empty keeps those followed). The YouTube channels the bot follows for every server, comma-separated `@handle`, channel URL or `UC…` ID |
| `TWITCH_CHANNELS` | Optional. Twitch channels the bot follows for every server (logins, comma-separated, e.g. `nobaman`). Their past broadcasts (archives) are read every `TWITCH_SYNC_MINUTES` (default `60`) and the assistant finds them with `search_twitch`: title, date, length and link only (Twitch does not let others read a video's content, so there is no summary). Twitch deletes archives after 7 to 60 days; those go here too. Needs `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Optional. An application registered at https://dev.twitch.tv/console (any OAuth redirect URL, e.g. `http://localhost`); the bot uses an app access token (client credentials), so no Twitch account is signed in |
| `YOUTUBE_AUTO_SYNC_MINUTES` | Optional. How often to check the bot's YouTube channels for new videos. Defaults to 15; 0 turns it off |
| `YOUTUBE_LIVE_POLL_SECONDS` | Optional. How often to check for streams on servers with stream events on. Defaults to 60; 0 turns it off |
| `YOUTUBE_WEBSUB_URL`, `YOUTUBE_WEBSUB_SECRET` | Optional. The service's public HTTPS address and a secret, to receive YouTube pushes (see above). `PORT` sets the port listened on (Railway sets it) |
| `HISTORY_BACKFILL` | Optional. `false` stops reading channels' past messages back (see "What is stored"). On by default |
| `HISTORY_BACKFILL_DAYS` | Optional. How many days of past messages to read back; unset or `0` for no day limit (with `HISTORY_BACKFILL_SINCE` unset too, everything is read back). Never past `MESSAGE_HISTORY_DAYS` |
| `HISTORY_BACKFILL_SINCE` | Optional. Read past messages back only to this date (`YYYY-MM-DD`, Japan time). With `HISTORY_BACKFILL_DAYS` too, the later of the two |
| `HISTORY_BACKFILL_MAX_MESSAGES` | Optional. At most this many past messages per channel (newest first); unset or `0` for no limit |
| `HISTORY_BACKFILL_DELAY_MS` | Optional (default `1000`). Wait between two history requests (100 messages each) |
| `SERVER_LORE` | Optional. `true` learns each server's running jokes, words and tone from its stored messages in `@everyone` channels, and lets `about_member` read a member's recent messages when asked (see "What each server is like"). Off by default: update the Privacy Policy and the intent answers first |
| `SERVER_LORE_WEEKS` | Optional (default `8`). How many recent weeks of messages `SERVER_LORE` learns from; older knowledge is dropped |
| `MESSAGE_EMBEDDINGS` | Optional. `true` embeds every stored message for search by meaning (sends them to Gemini; see above). Off by default |
| `MESSAGE_EMBEDDING_MIN_CHARS` | Optional. Messages with fewer letters or digits than this, once links, emojis and mentions are taken out, are not embedded or found by meaning (nor is laughter such as `www` or `草`, nor commands to bots such as `!rank`, `/roll` or `.play …`). Default 5 |
| `EMBEDDING_BATCH_AFTER_HOURS` | Optional (default `24`). With `MESSAGE_EMBEDDINGS=true`, messages older than this many hours (the history read back, a backlog) are embedded through Gemini's Batch API: half the price, done within a day, in batches of up to `EMBEDDING_BATCH_SIZE` messages (default `2000`; Gemini sends a batch's results back in one piece, some 6 KB a message, so a much larger one may not come back in time), up to `EMBEDDING_BATCH_CONCURRENCY` (default `3`) at a time, checked every run (`EMBEDDING_INTERVAL_MINUTES`) and kept across restarts. Where each batch stands is kept with it (`embedding_batches.state`, `checked_at`, `last_error`; likewise `youtube_summary_batches`); one that cannot be looked at is tried again on the next run without holding up recent messages, and one Gemini no longer has, or still not done after 50 hours (Gemini keeps a batch 48), is given up on and its messages sent again. Newer messages are embedded right away so they can be found soon (Flex inference does not take embedding models). `0` embeds everything right away |
| `EMBEDDING_INTERVAL_MINUTES` | Optional. How often to embed new videos and messages. Defaults to 5; 0 turns it off |
| `GEMINI_EMBEDDING_MODEL` | Optional. Defaults to `gemini-embedding-001` |
| `YOUTUBE_GATEWAY_PROVIDER` | Optional. Slug of an AI Gateway custom provider (see below). Set, YouTube API calls go through Cloudflare AI Gateway; unset, straight to Google |
| `GEMINI_IMAGE_MODEL` | Optional. Image model for AI-made covers. Defaults to `gemini-3.1-flash-image` |
| `CHAT_PERSONA` | Optional. Character notes added to chat replies (tone, catchphrases, how to address members) |
| `GCP_SECRETS`, `GCP_SERVICE_ACCOUNT_KEY` | Optional. Load secrets from Google Cloud Secret Manager at startup (see above). `GCP_PROJECT_ID` overrides the key's project |

Values that never differ between deployments are constants in code rather than environment
variables: the support server and legal URLs (`src/bot/utils/constants.js`) and the message batch
size (`src/db/messageBatcher.js`).

## Data retention

`src/miscellaneous/prune.js` deletes message rows older than `MESSAGE_HISTORY_DAYS`, in batches. Run
it either way:

- **In-process (default):** the worker owning shard 0 sweeps hourly. Nothing to configure beyond
  `MESSAGE_HISTORY_DAYS`.
- **As a cron job:** `node src/miscellaneous/prune.js` prunes once, prints the number of rows
  deleted, and exits. Give it the same `PG*` variables, and set `PRUNE_EXTERNAL=true` on the bot so
  the sweep is not scheduled twice.

Once a row is pruned, deleting or editing that message logs that it happened but cannot show the
content. Messages that were never stored at all stay silent, as before.

## Usage

```bash
node index.js          # the bot
npm run lint           # eslint
npm test               # standard
npm run test:unit      # unit tests (node:test)
npm run test:it        # integration tests: mention → tools → buttons → event, with Discord and Gemini faked
```

Tests need no database, Redis, Discord or Gemini: `test/helpers/fakes.js` stands in for them, and web
pages come from a local HTTP server. CI runs both suites on every pull request.

## Contributing

This is a fork maintained for one community, so changes are judged by what that community needs
rather than by what suits a public logging bot. Before opening a pull request:

1. Does it keep the bot within its Discord rate limits?
2. Does it change what data is stored, sent, or kept? If so, update the Privacy Policy and
   Terms of Service in the same pull request — and the answers in
   [`docs/discord/privileged-intent-review.md`](docs/discord/privileged-intent-review.md) if it
   touches anything the intent review declares.
3. Does it need a new privileged intent? That requires a fresh review request to Discord, so raise
   it before writing the code.

Discuss it in the support server first: https://discord.com/invite/nobaman

## License

AGPL-3.0-or-later, inherited from [Logger](https://github.com/curtisf/logger). See [LICENSE.md](LICENSE.md).
