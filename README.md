RoboPolice (ロボポリス) is a **private** [Discord](https://discord.com) audit-logging app. It is not
publicly listed. It runs in one community server, whose staff operate it for that server's own
moderation, plus a few private test servers they use for staging changes.
Support: https://discord.com/invite/nobaman

It is a fork of [Logger v3](https://github.com/curtisf/logger) (AGPL-3.0). Upstream documentation
below describes self-hosting the original project.

## Legal

- [Privacy Policy](PRIVACY.md)
- [Terms of Service](TERMS.md)

These are the documents registered with Discord for this application; keep them in sync with what the
code actually does before changing data handling.

## Installation

You are mostly on your own selfhosting this version. Required applications:
- PostgreSQL 11
- Redis
- NodeJS 14+ (14.5.0)

1. Setup Postgres and add a superuser (default user works)
2. Clone bot repo and enter the created folder
3. Copy .env.example into .env
4. Fill out **all** fields in it (even Sentry unless you hotpatch it out)
5. `npm install`
6. `node src/miscellaneous/generateDB.js`
7. Set `ENABLE_TEXT_COMMANDS="true"` in .env
8. `node index.js`
9. Use your prefix to set the bot's commands. If yours is %, then you'd do `%setcmd global` to globally set commands, and `%setcmd guild` to quickly set server-specific slash commands

## Usage

```bash
node index.js
```

## Contributing
Pull requests are welcome as long as it follows the following guidelines:
1. Is your idea really one that a large group of moderators would like?
2. Is your idea scalable?
3. Will your idea cause the bot to hit it's global ratelimit?
4. Have you proposed it to *piero#5432* in my [support server?](https://discord.gg/ed7Gaa3)

If you have done all of the above steps, then open a pull request and I will review it. Style guide and testing will be implemented in a later update.
