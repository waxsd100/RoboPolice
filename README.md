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

- [Privacy Policy](PRIVACY.md)
- [Terms of Service](TERMS.md)

These are the documents registered with Discord for this application. **Keep them in sync with what
the code actually does** — if you change what is stored, where it is sent, or how long it is kept,
update them in the same change. The application for privileged intent access attests that they are
accurate, and the reviewer can read this repository.

## Privileged intents

The app requires two privileged intents, both enabled in the Developer Portal:

| Intent | Why |
|---|---|
| **Server Members** | `GUILD_MEMBER_ADD` / `REMOVE` / `UPDATE` are not delivered without it, so join, leave, kick, nickname and role logging cannot work. Also resolves nicknames and roles shown in every other log embed. |
| **Message Content** | A deleted message cannot be fetched back from the API, so its content must be received before deletion to be shown in a deletion or edit log. |

**Presence is not used** and must stay disabled.

See [`docs/discord/privileged-intent-review.md`](docs/discord/privileged-intent-review.md) for the
intent review submission, where every claim is mapped to the code that backs it.

## What is stored

Short version; [PRIVACY.md](PRIVACY.md) is authoritative.

| Data | Where | Retention |
|---|---|---|
| Message ID, author ID, timestamp, AES-256 encrypted content and attachment URLs | PostgreSQL `messages` | `MESSAGE_HISTORY_DAYS` days, or forever if unset |
| Per-server settings (log channels, ignored channels, disabled events) | PostgreSQL `guilds` | Until the app leaves the server |
| Invite counters, webhook handles, guild settings | Redis | 3 hours |

Message rows are written **only for servers that have a message deletion or edit log channel
configured** — a server with none never has message content stored, since nothing could read it back.

## Requirements

- PostgreSQL 11+
- Redis
- Node.js 14.5+

## Setup

1. Set up Postgres with a superuser (the default user works)
2. Clone the repo and enter the folder
3. `cp .env.example .env` and fill it in. Every value is required except the ones marked optional
4. `npm install`
5. `node src/miscellaneous/generateDB.js` to create the database and tables
6. Set `ENABLE_TEXT_COMMANDS="true"` in `.env`
7. `node index.js`
8. Register slash commands with the text prefix: `%setcmd global` for global commands, or
   `%setcmd guild` for faster server-scoped registration (substitute your `GLOBAL_BOT_PREFIX`)

## Configuration worth knowing

| Variable | Effect |
|---|---|
| `MESSAGE_HISTORY_DAYS` | Retention window. Unset (or 0/non-numeric) means retention is unlimited by design — nothing is ever pruned, and `/help`/`/clearmydata` say so instead of naming a day count. The bot logs which mode it's in at startup. If you go unlimited on a real deployment, update PRIVACY.md's retention section to match, since it currently states a fixed number of days. |
| `STAFF_ROLE_ID` | Optional. A member holding this role, or any role at or above it in Settings > Roles, bypasses the same permission checks a server owner already bypasses — not creator-only commands, and not what the bot itself needs. Unset disables it entirely. |
| `PRUNE_EXTERNAL` | Set `true` only when running `prune.js` as a separate cron service, so the bot stops scheduling its own sweep |
| `SENTRY_URI` | Optional. When set, errors and stack traces are sent to Sentry — a third party, disclosed in PRIVACY.md. Leave unset to keep error reporting local |
| `PASTE_SITE_ROOT_URL` | Optional. Where `/archive` and bulk-deletion logs upload message text. Anyone with the resulting link can read it, so self-host it. Unset disables both features |
| `MESSAGE_BATCH_SIZE` | Messages buffered in memory before a batched insert. Larger means fewer writes but more messages lost on an unclean restart |

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
```

## Contributing

This is a fork maintained for one community, so changes are judged by what that community needs
rather than by what suits a public logging bot. Before opening a pull request:

1. Does it keep the bot within its Discord rate limits?
2. Does it change what data is stored, sent, or kept? If so, update [PRIVACY.md](PRIVACY.md) and
   [TERMS.md](TERMS.md) in the same pull request — and the answers in
   [`docs/discord/privileged-intent-review.md`](docs/discord/privileged-intent-review.md) if it
   touches anything the intent review declares.
3. Does it need a new privileged intent? That requires a fresh review request to Discord, so raise
   it before writing the code.

Discuss it in the support server first: https://discord.com/invite/nobaman

## License

AGPL-3.0-or-later, inherited from [Logger](https://github.com/curtisf/logger). See [LICENSE.md](LICENSE.md).
