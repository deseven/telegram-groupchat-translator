# telegram-groupchat-translator
A bot that translates messages in Telegram group chats, using DeepL or ChatGPT. Allows to set which users will have their messages translated, to what language and with which translation service. Intended for group chats where several individuals speaking different languages would convene.

## Requirements
 - any environment that can run node.js
 - 64MB of RAM

## Installation
#### Prerequisites
1. Create a new bot with [@BotFather](https://t.me/BotFather), copy bot token.
2. Clone this repo or download the code archive.
3. Copy `.env.example` to `.env` and edit it, bare minimum would be `WEBHOOK_URL`, `BOT_TOKEN`, `ADMIN_USER_ID` and service-specific parameters for at least one service (DeepL or ChatGPT).
4. Set up a reverse proxy so your webhook URL would actually be available via HTTPS.

#### With docker compose (recommended)
5. Run `docker compose up -d`.

#### Manually
5. Install node.js 18 (higher versions could work too, untested).
6. Run `npm i`.
7. Run `npm run start`.

## Usage
1. Send `/start` to the bot, it should answer with an introductory message.
2. Add the bot to the group chat (or chats).
3. Use bot commands to add translation rules.

## Notes
 - on the `info` log level, bot outputs all user IDs of all incoming messages to stdout, in case you need a quick way to get them
 - there is little to no validation for private bot commands, so be mindful about what you're doing
 - for the list of supported languages look [here](https://developers.deepl.com/docs/resources/supported-languages#target-languages) (this is for DeepL, but the same language code is getting passed to ChatGPT)