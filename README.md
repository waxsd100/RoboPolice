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
