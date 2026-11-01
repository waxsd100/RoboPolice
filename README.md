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
| Message ID, author ID, channel ID, server ID, timestamp, content and image URLs (not encrypted by the app; see below) | PostgreSQL `messages`, `message_attachments` | `MESSAGE_HISTORY_DAYS` days, or forever if unset; all of a server's go when the app leaves it |
| Per-server settings (log channels, ignored channels, disabled events), and the server's name, icon URL, member count and when the app joined | PostgreSQL `guilds`, `guild_emojis` (custom emojis with an AI description), `guild_event_logs`, `guild_ignored_channels`, `guild_disabled_events` | Until the app leaves the server |
| Invite counters, webhook handles, guild settings | Redis | 3 hours |
| The YouTube channels the bot follows (`YOUTUBE_CHANNELS`), their descriptions and every video read from them, each server's event setting, plus summaries of linked videos' contents (public YouTube data) | PostgreSQL `youtube_channels`, `youtube_videos`, `youtube_summaries`, `guild_youtube_summaries`, `guilds.youtube_live_events` | Channels and videos until the bot no longer follows the channel; summaries while their video is stored, or else until no server that asked for them remains |

Message content, image URLs and message embeddings are stored as they are: the app no longer
encrypts them with `AES_KEY` (migration 006 decrypted what was stored), since encryption is moving
into the database with pgcrypto. Until then, anyone who can read the database can read them.
`AES_KEY` is still needed: for invite codes in Redis, and to run migrations 003 and 006 on a database
that still has encrypted rows.

Message rows are written **only for servers that have a message deletion or edit log channel
configured** — a server with none never has message content stored, since nothing could read it back.

## コマンド一覧

### メンション（BOT に話しかける）

`@ロボポリス` と BOT にメンションして、文章で頼みます。オーナーのサーバーでは1人1日30回まで（`MENTION_DAILY_LIMIT`）、それ以外のサーバーでは1人1日5回・サーバー全体で1日30回まで。

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

| コマンド | 内容 | 必要な権限 |
|---|---|---|
| `/youtube sync` | BOT が見ているチャンネルを読み直し、新しい動画と配信の状態を取り込む（普段は自動。オーナーのサーバーからのみ） | サーバーの管理 |
| `/youtube summarize count:<1〜50> force:<True/False> url:<動画リンク>` | まだ要約していない動画を新しい順に `count` 本（初期値 3）要約する。3本ずつ同時に要約する（`VIDEO_SUMMARY_CONCURRENCY` で1〜10本に変更可）。本数が多いと時間がかかる。`force:True` で要約済みも作り直す。`url` を指定するとその1本だけを要約して内容を表示する（他のチャンネルの動画でも可） | サーバーの管理 |
| `/youtube liveevents enabled:<True/False>` | 配信をサーバーのイベントとして自動で登録する（予定の枠で作成、開始で開催中、終了で終了）。説明の先頭に AI が配信内容の紹介を書き、終了後はアーカイブを自動で要約する。新しく投稿された動画も「📺 新着動画」として投稿から24時間イベントにする | サーバーの管理（BOT にイベントの管理） |
| `/youtube show` | 設定しているチャンネル、保存している動画の数、配信の予定、配信のイベント登録の有無を表示する | サーバーの管理 |
| `/setup via_presets` | よく使うログをまとめて有効にする | Webhook の管理・チャンネルの管理・監査ログの表示 |
| `/setup via_individual_event` | ログの種類を1つずつ選んで有効にする | 同上 |
| `/setup list` | ログの出力先チャンネルの一覧を表示する | 同上 |
| `/stoplogging channel:<チャンネル>` | 指定したチャンネルへのログ出力を止める（`other` ですべて止める） | Webhook の管理・チャンネルの管理 |
| `/ignorechannel channel-to-ignore:<チャンネル>` | 指定したチャンネルの出来事をログに出さない／出すを切り替える（`optional` で一覧・リセット） | Webhook の管理・チャンネルの管理 |
| `/logbots` | 他の BOT の操作もログに出すかを切り替える（初期値: 出さない） | Webhook の管理・チャンネルの管理 |
| `/serverinfo` | サーバーの情報（ロール数・メンバー数・機能など）を表示する | なし |
| `/userinfo user:<ユーザー>` | ユーザーの情報（参加日・作成日・ロールなど）を表示する | なし |
| `/clearmydata` | 保存データの削除の方法を表示する | なし |
| `/invite` | BOT の招待リンクを表示する | なし |
| `/help event:<イベント> guide:<項目>` | ヘルプを表示する | なし |
| `/ping` | BOT が動いているか確認する | なし |

`/youtube` の新しいサブコマンドを追加したときは、下の `%setcmd` でコマンドを登録し直さないと Discord に表示されません。

### テキストコマンド（`%` は `GLOBAL_BOT_PREFIX`）

| コマンド | 内容 | 使える人 |
|---|---|---|
| `%setcmd guild` / `%setcmd global` | スラッシュコマンドを Discord に登録する（`guild` はこのサーバーだけですぐ反映、`global` は全サーバー） | `CREATOR_IDS` の人 |
| `%setchannel` | ログの出力先チャンネルとイベントを設定する | Webhook の管理・チャンネルの管理・監査ログの表示 |
| `%stoplogging` / `%ignorechannel` / `%logbots` | スラッシュコマンドと同じ | 管理者・チャンネルの管理 |
| `%reset` | サーバーのログ設定をすべて消す（`yes` と返信して確定） | 管理者 |
| `%help` / `%info` / `%invite` / `%ping` / `%serverinfo` / `%userinfo` / `%clearmydata` | ヘルプ・BOT の情報・招待リンクなど | だれでも |
| `%eval` / `%reload` / `%reindexcommands` | 開発用 | `CREATOR_IDS` の人 |

## Events and forum posts from a mention

Mention the app with a description, an event page URL, or a Discord message link
(`@RoboPolice 11/3 19時から交流会 https://...`, `@RoboPolice これを募集フォーラムに立てて`), or reply to a
message and mention it. It drafts either a server scheduled event or a forum post, shows it with
Register / Post and Cancel buttons, and creates it only after the requester confirms. Anyone can
mention it; what a request makes is checked when it is drafted. Registering or changing an event
needs **Manage Events** from the requester (or the owner, an administrator, or `STAFF_ROLE_ID`
staff) and from the app; a forum post needs both the requester and the app to be able to post in that
forum, and is sent with mentions disabled so drafted text can't ping anyone.

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

The server profile lists the server's custom emojis (those not limited to roles), and chat replies
use one now and then where it fits. An emoji the model writes as `:name:` is turned into the
server emoji of that name.

With `WIKI_URLS` set, the community's wiki is knowledge too (`src/bot/modules/wikiKnowledge.js`):
the worker owning shard 0 reads every page of it once a week (one page a second, only the `/d/`
pages its robots.txt allows), splits each at its headings, and stores the parts with embeddings in
`wiki_pages` and `wiki_sections`. Gemini then takes knowledge out of each part, as structured
JSON, into `wiki_facts`: characters (name, other names and readings, who they are and how they
look), quotes (the words, and who said them when) and terms (running jokes, the community's words
and what they mean), each embedded on its own; a part is read again only when it changes. The model
searches all of it with `search_wiki` (the knowledge first, then the pages for detail), and uses its quotes now and then as the streamer would. It is fans' writing, so
the model does not state it as the streamer's own word.

With `TWITTER_ACCOUNTS` set, the streamer's own X posts are knowledge too
(`src/bot/modules/twitterKnowledge.js`). They are read through FxTwitter's public API
(api.fxtwitter.com), not X's: the first time up to `TWITTER_MAX_PAGES` pages back, then every
`TWITTER_REFRESH_HOURS` until posts already stored, one request every 2 seconds, a failed request
tried again twice. Reposts of others are left out. Posts are stored in `x_posts`, and each
month's posts are written as one page of the X knowledge tables `x_pages` / `x_sections` /
`x_facts` (one line per post with its date and URL; the same shape as the wiki's tables, kept apart
from them), so knowledge is taken out of them and they are searched with `search_wiki` together
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
are stored in `discord_posts`, and each account's messages of a month become one page of
`discord_pages` / `discord_sections` / `discord_facts` (one line per message with its date, channel
and link), so knowledge is taken out of them and they are searched with `search_wiki` together with
the wiki and the X posts; the model gives a message's link when it mentions one. Threads are not read.

With `KNOWLEDGE_TOPICS` set (comma-separated or one per line, each with what it is, e.g.
`ぽみそしる（のばまんが所属する実況者グループ）`), topics the wiki and the posts say little about are
looked up on the web (`src/bot/modules/webKnowledge.js`): Gemini searches each with Google Search
once every `WEB_REFRESH_HOURS` (default 168) and sums up what it found (members, when it started,
what it does, official links) with its sources and the date. That is stored in `web_pages` /
`web_sections` / `web_facts`, its knowledge taken out and searched with `search_wiki` like the rest;
the model says it is what was found as of that date, not certain fact.

Each emoji is described once from its image and name by Gemini (what it shows, when to use it) and
stored with an embedding of that description in `guild_emojis` (`src/bot/modules/emojiDescriber.js`).
When the wiki describes characters (pages whose title has キャラクター), Gemini is given them, so an
emoji of a character is named; when what the wiki says about them changes, the emojis are described
again.
Each worker does this in the background for the servers it hosts, at startup and when a server's
emojis change; a renamed emoji is described again. The profile then lists each emoji with its
description, those closest in meaning to the request first. `EMOJI_DESCRIPTIONS=false` turns it off.

Mentions answered per day (Japan time) are counted in Redis (`src/bot/utils/mentionQuota.js`): in
the owner's servers (`OWNER_GUILD_IDS`) 30 per user (`MENTION_DAILY_LIMIT`); in any other server 5
per user and 30 for the whole server (`MENTION_DAILY_LIMIT_OTHER`, `MENTION_GUILD_DAILY_LIMIT_OTHER`).
If Redis is unreachable the mention goes through.

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
ended after `UPLOAD_EVENT_HOURS` (default 24); `UPLOAD_EVENTS=false` turns that off. Each stream's event follows it: made when the stream is scheduled, with its title,
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
- A message's embedding goes with its message: a foreign key
  deletes it when the message is deleted (retention, `/clearmydata`, leaving a server), and an edit
  drops it to be made again. Messages stored before channels were recorded are not embedded.
- With message embeddings on, **every stored message is sent to Google Gemini** to be embedded, not
  only mentions. Update the Privacy Policy and the privileged intent answers before turning it on.

Every Gemini call goes through Cloudflare AI Gateway. YouTube Data API calls can too: in the
dashboard, add a custom provider (AI Gateway → Custom Providers) with base URL
`https://www.googleapis.com` and a slug such as `youtube`, then set `YOUTUBE_GATEWAY_PROVIDER=youtube`.
Requests then go to `…/custom-youtube/youtube/v3/…` with the gateway token. Either way the API key is
sent in the `x-goog-api-key` header, never in the URL.

The model searches all of it (titles, descriptions and summaries) with the `search_youtube` tool.

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
`CLOUDFLARE_AI_GATEWAY_TOKEN` and `YOUTUBE_API_KEY`. Everything else stays on Railway, including the database and Redis
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
| `STAFF_ROLE_ID` | Optional. A member holding this role, or any role at or above it in Settings > Roles, bypasses the same permission checks a server owner already bypasses — not creator-only commands, and not what the bot itself needs. Unset disables it entirely. |
| `PRUNE_EXTERNAL` | Set `true` only when running `prune.js` as a separate cron service, so the bot stops scheduling its own sweep |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID` | Enable drafting events and forum posts from mentions. Unset means mentions are ignored |
| `CLOUDFLARE_AI_GATEWAY_TOKEN` | Optional. Sent as `cf-aig-authorization` for an authenticated gateway |
| `CLOUDFLARE_AI_GATEWAY_BYOK_ALIAS` | Optional. Name of the Gemini key stored in the gateway (BYOK), sent as `cf-aig-byok-alias`. Unset uses the key named `default` |
| `GEMINI_API_KEY` | Optional when the key is stored in the gateway (BYOK); otherwise required for drafting from mentions |
| `GEMINI_MODEL` | Optional. Defaults to `gemini-flash-latest` |
| `GEMINI_TEMPERATURE` | Optional (default `0.7`, 0–2). How varied mention replies and drafts are; higher is more varied. Drafts are checked field by field either way |
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
| `OWNER_GUILD_IDS` | Optional. The owner's servers (comma-separated), default `615170683068219393`. They get the looser mention limit and go first in all background AI work; every other server waits for them |
| `MENTION_DAILY_LIMIT_OTHER`, `MENTION_GUILD_DAILY_LIMIT_OTHER` | Optional. Mentions a day outside the owner's servers: per user (default 5) and for the whole server (default 30). `MENTION_DAILY_LIMIT` (default 30) is per user in the owner's servers. 0 turns a limit off |
| `AI_BACKGROUND_CONCURRENCY` | Optional. How many background AI jobs (video and archive summaries, emoji descriptions, stream blurbs) run at once on a worker (default 3) |
| `EVENT_GAME_MENTIONS` | Optional. `true` puts each game's Discord game mention in a stream's event too (off by default: check that your server's events show it as the game) |
| `GAME_LINKS` | Optional. `false` leaves out the pages (Steam or official) of the games a stream's event names |
| `EMOJI_DESCRIPTIONS` | Optional. `false` stops describing the server's custom emojis (Gemini looks at each one's image and name; the descriptions are embedded so the emojis that suit a request are offered first) |
| `LIVE_EVENT_AI_DESCRIPTION` | Optional. `false` stops the AI's line on what a stream is about (from its title, description and thumbnail) at the top of its Discord event |
| `LIVE_ARCHIVE_SUMMARY` | Optional. `false` stops summarizing a stream's archive once it is over (tried 30 minutes after it ends, then hourly, three times at most) |
| `VIDEO_SUMMARY_CONCURRENCY` | Optional. How many videos `/youtube summarize` summarizes at once (1-10). Defaults to 3 |
| `YOUTUBE_CHANNELS` | Optional (default `UCTW2tw0Mhho72MojB1L48IQ,UCz7pNw3UkTF9WQjHcYpFD9g`, のばまんゲームス and のばまん・ロー・エフォート; empty keeps those followed). The YouTube channels the bot follows for every server, comma-separated `@handle`, channel URL or `UC…` ID |
| `YOUTUBE_AUTO_SYNC_MINUTES` | Optional. How often to check the bot's YouTube channels for new videos. Defaults to 15; 0 turns it off |
| `YOUTUBE_LIVE_POLL_SECONDS` | Optional. How often to check for streams on servers with stream events on. Defaults to 60; 0 turns it off |
| `YOUTUBE_WEBSUB_URL`, `YOUTUBE_WEBSUB_SECRET` | Optional. The service's public HTTPS address and a secret, to receive YouTube pushes (see above). `PORT` sets the port listened on (Railway sets it) |
| `MESSAGE_EMBEDDINGS` | Optional. `true` embeds every stored message for search by meaning (sends them to Gemini; see above). Off by default |
| `EMBEDDING_INTERVAL_MINUTES` | Optional. How often to embed new videos and messages. Defaults to 5; 0 turns it off |
| `GEMINI_EMBEDDING_MODEL` | Optional. Defaults to `gemini-embedding-001` |
| `YOUTUBE_GATEWAY_PROVIDER` | Optional. Slug of an AI Gateway custom provider (see below). Set, YouTube API calls go through Cloudflare AI Gateway; unset, straight to Google |
| `GEMINI_IMAGE_MODEL` | Optional. Image model for AI-made covers. Defaults to `gemini-3.1-flash-image` |
| `CHAT_PERSONA` | Optional. Character notes added to chat replies (tone, catchphrases, how to address members) |
| `MENTION_DAILY_LIMIT` | Optional. Mentions each user can have answered per day (Japan time). Defaults to 30; 0 turns the limit off |
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
