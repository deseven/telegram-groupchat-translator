# telegram-groupchat-translator
A bot that translates messages in Telegram group chats, using any OpenAI-compatible API. Allows you to specify which users should have their messages translated and into which language. Intended for group chats where several people speaking different languages would talk.

## Requirements
 - any environment that can run node.js
 - 64MB of RAM
 - any reverse proxy web server that can handle SSL (for incoming messages webhook)

## Installation
#### Prerequisites
1. Create a new bot with [@BotFather](https://t.me/BotFather), copy bot token.
2. Clone this repo or download the code archive.
3. Copy `.env.example` to `.env` and edit it, bare minimum would be `WEBHOOK_URL`, `BOT_TOKEN`, `ADMIN_USER_ID` and the OpenAI parameters (`OPENAI_API_KEY`).
4. Set up a reverse proxy so your webhook URL would actually be available via HTTPS.

#### With docker compose (recommended)
5. Run `docker compose up -d`.

#### Manually
5. Install node.js 22 or higher.
6. Run `npm i`.
7. Run `npm run start`.

## Usage
1. Send `/start` to the bot, it should answer with an introductory message.
2. Add the bot to the group chat (or chats).
3. Use bot commands to add translation rules:
   - `/whitelist_add USER_ID TARGET_LANG [PRONOUNS] [COMMENT]` — add or edit a user
   - `/whitelist_remove USER_ID` — remove a user
   - `/whitelist` — display the current whitelist

## Notes
 - on the `info` log level, bot outputs all user IDs of all incoming messages to stdout, in case you need a quick way to get them
 - `TARGET_LANG` is the language code passed straight to the model (e.g. `EN`, `RU`); refer to your provider's/model's documentation for the accepted values
 - incoming messages are processed strictly one-by-one, in arrival order
 - on a failed translation the request is retried with exponential backoff (1s, 2s, 4s, ... up to `MAX_RETRIES`, default 10). Non-retryable errors (e.g. authentication failures) abort immediately
 - there's a `/health` endpoint that could be used for monitoring