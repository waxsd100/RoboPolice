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
| Message ID, author ID, timestamp, AES-256 encrypted content and attachment URLs | PostgreSQL `messages` | `MESSAGE_HISTORY_DAYS` days, or forever if unset |
| Per-server settings (log channels, ignored channels, disabled events) | PostgreSQL `guilds` | Until the app leaves the server |
| Invite counters, webhook handles, guild settings | Redis | 3 hours |
| The YouTube channel set with `/youtube`, its description and up to 50 recent videos (public YouTube data) | PostgreSQL `youtube_channels`, `youtube_videos` | Until the next `/youtube sync`/`set`, or the app leaves the server |

Message rows are written **only for servers that have a message deletion or edit log channel
configured** — a server with none never has message content stored, since nothing could read it back.

## Events and forum posts from a mention

Mention the app with a description, an event page URL, or a Discord message link
(`@RoboPolice 11/3 19時から交流会 https://...`, `@RoboPolice これを募集フォーラムに立てて`), or reply to a
message and mention it. It drafts either a server scheduled event or a forum post, shows it with
Register / Post and Cancel buttons, and creates it only after the requester confirms. Only members
who can manage events (or the owner, or `STAFF_ROLE_ID` staff) can use it. Events need the app to
have **Manage Events**; a forum post needs both the requester and the app to be able to post in that
forum, and is sent with mentions disabled so drafted text can't ping anyone.

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
Questions about "this channel" are answered by reading its recent messages on demand; message
history is never stored for this.

### YouTube knowledge

`/youtube set channel:<URL or @handle>` (Manage Server) sets the server's YouTube channel and reads it
right away; `/youtube sync` reads it again and `/youtube show` shows what is stored. A read takes the
channel's description and its 50 most recent uploads, including whether each is upcoming or live and
when, through the YouTube Data API (`YOUTUBE_API_KEY`, 3 quota units per read), and replaces what was
stored. The model searches it with the `search_youtube` tool. The tables are created on first use,
so existing deployments need no migration.

What the tools read (the mention, the replied-to message, linked pages and Discord messages, the
server profile, stored YouTube data) is sent to Google Gemini through Cloudflare AI Gateway. Nothing
from this flow is stored by the app. Use a paid Gemini API tier: on the free tier Google may use the input to improve its models,
which the intent review answers rule out.

The preview has Register / Post, **Fix** and Cancel buttons. Fix asks the requester to type what to
change as their next message in the channel; the correction goes back to the model, which revises
its own draft (up to 3 times). Questions the model asks can likewise be answered in words with
"その他（文字で入力）". A forum mentioned in the request (`@RoboPolice #募集 に立てて`) is always the
one posted to.

The model can also pick an image for the event cover or the forum post: an `og:image` /
`twitter:image` of a page it read, an image attached to the mention or the replied-to message, or an
embed image. The app downloads it (same address checks as pages, images only, 10MB at most) and the
preview shows the actual result, 800×320 for an event cover or 1280×720 for a forum post. A second
row of buttons switches how it is made (`src/bot/modules/coverImage.js`):

| Mode | What it does | Default for |
|---|---|---|
| 切り抜き | Crops with sharp's attention strategy, keeping the most salient region | Images close to the target shape (photos) |
| 全体表示 | Shows the whole image over a blurred, darkened copy of itself | Posters and anything far from the target shape |
| AIで作成 | Gemini's image model (`GEMINI_IMAGE_MODEL`) makes a new cover from the title and description, based on the source image if there is one, without text | — |
| なし | No image | Drafts without an image |

"AIで作成" sends the title, description and the source image to Gemini, the same way drafting does.
If an image can't be used the draft still works, and the preview says why.

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
5. `node src/miscellaneous/generateDB.js` to create the database and tables
6. `node index.js`
7. Register slash commands with the text prefix: `%setcmd global` for global commands, or
   `%setcmd guild` for faster server-scoped registration (substitute your `GLOBAL_BOT_PREFIX`)

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
| `YOUTUBE_API_KEY` | Optional. YouTube Data API v3 key for `/youtube`. Unset disables the command |
| `GEMINI_IMAGE_MODEL` | Optional. Image model for AI-made covers. Defaults to `gemini-3.1-flash-image` |

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
