require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const axios = require('axios');
const OpenAI = require('openai');

// -- Environment Variables --
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn'; // default to 'warn'
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;    // admin ID

// DeepL
const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;

// ChatGPT
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

// -- Winston Logger --
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

logger.info('Bot is starting up...');

// -- Load Whitelist from whitelist.json --
let userWhitelist = {};
try {
  const rawData = fs.readFileSync('./whitelist.json', 'utf-8');
  const data = JSON.parse(rawData);

  if (Array.isArray(data.users)) {
    data.users.forEach((user) => {
      const { id, target_lang, service } = user;
      if (id && target_lang && service) {
        userWhitelist[id] = {
          target_lang,
          service: service.toLowerCase() // "deepl" or "chatgpt"
        };
      }
    });
    logger.info(`Loaded ${Object.keys(userWhitelist).length} whitelisted user(s).`);
  }
} catch (err) {
  logger.error("Error reading or parsing whitelist.json:");
}

// -- Helper to Save Whitelist to File --
function saveWhitelistToFile() {
  const usersArray = Object.entries(userWhitelist).map(([id, data]) => ({
    id: Number(id),
    target_lang: data.target_lang,
    service: data.service
  }));

  const updatedJson = { users: usersArray };

  try {
    fs.writeFileSync('./whitelist.json', JSON.stringify(updatedJson, null, 2), 'utf-8');
    logger.info("Successfully updated whitelist.json");
  } catch (err) {
    logger.error("Error writing to whitelist.json:", err);
  }
}

/**
 * -------------------------
 *        DeepL Helper
 * -------------------------
 */
async function callDeepL(text, targetLang) {
  // Single attempt calling DeepL with 10s timeout
  const response = await axios({
    method: 'POST',
    url: 'https://api-free.deepl.com/v2/translate',
    headers: {
      'Authorization': `DeepL-Auth-Key ${DEEPL_AUTH_KEY}`,
      'Content-Type': 'application/json'
    },
    data: {
      text: [text],
      target_lang: targetLang
    },
    timeout: 10000 // 10 seconds
  });

  if (
    response.data &&
    response.data.translations &&
    response.data.translations[0] &&
    response.data.translations[0].text
  ) {
    return response.data.translations[0].text;
  }

  throw new Error('Invalid DeepL response format');
}

/**
 * -------------------------
 *       ChatGPT Helper
 * -------------------------
 */
async function callChatGPT(text, targetLang) {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: `You are a helpful AI that translates user content into language code ${targetLang}. Rules:
 - the content is a chat message, so slang and informal wording are acceptable, be casual but precise
 - output only the translated message and nothing else
 - if the text is already in that language, return it as-is`
      },
      {
        role: 'user',
        content: text
      }
    ],
    temperature: 0.2
  });

  if (
    response.choices &&
    response.choices[0] &&
    response.choices[0].message &&
    response.choices[0].message.content
  ) {
    return response.choices[0].message.content.trim();
  }

  throw new Error('Invalid ChatGPT response format');
}

/**
 * -------------------------
 *  Translate w/ Retry (3x)
 * -------------------------
 */
async function translateText(text, targetLang, service) {
  const MAX_TRIES = 3;
  let attempt = 0;

  while (attempt < MAX_TRIES) {
    attempt++;
    try {
      logger.debug(`Attempt ${attempt}/${MAX_TRIES} for ${service.toUpperCase()} translation...`);

      if (service === 'deepl') {
        return await callDeepL(text, targetLang);
      } else if (service === 'chatgpt') {
        return await callChatGPT(text, targetLang);
      } else {
        throw new Error(`Unknown translation service: ${service}`);
      }
    } catch (err) {
      logger.error(`Translation attempt ${attempt} failed: ${err.message}`);
      if (attempt === MAX_TRIES) {
        throw err;
      }
    }
  }
  // Should never get here
  throw new Error('Unexpected error in translateText()');
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// 1. /start command in private chats
bot.start((ctx) => {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  logger.info(`Received "/start" from user ${userId} in chat: ${chatType}`);

  if (chatType === 'private') {
    ctx.reply(`Hello! This is a private translation bot. If you have admin rights you can use these commands:
/whitelist - to display current whitelist
/whitelist_add - to add or edit a user in the whitelist
/whitelist_remove - to remove a user from the whitelist

Otherwise you can set up your own instance, more info here:
https://github.com/deseven/telegram-groupchat-translator

Your User ID is ${userId}.`);
  }
});

// 2. Manage ANY message (text, photo, video, etc.)
bot.on('message', async (ctx) => {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;

  // If there's text, it's in ctx.message.text; if caption, in ctx.message.caption
  const messageText = ctx.message.text || ctx.message.caption;

  logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

  if (!messageText) {
    logger.debug('No text/caption found. Skipping translation.');
    return;
  }

  // -- Admin Commands (Private Chat) --
  // Make sure we only process these if it's a private chat AND the user is admin.
  if (chatType === 'private' && String(userId) === String(ADMIN_USER_ID)) {
    const trimmedText = messageText.trim();
    if (trimmedText.startsWith('/whitelist_add')) {
      // e.g. /whitelist_add 12345 RU chatgpt
      const parts = trimmedText.split(' ').slice(1); // everything after the command
      if (parts.length < 3) {
        ctx.reply('Usage: /whitelist_add USER_ID TARGET_LANG SERVICE');
        return;
      }
      const [userIdArg, targetLangArg, serviceArg] = parts;
      userWhitelist[userIdArg] = {
        target_lang: targetLangArg,
        service: serviceArg.toLowerCase()
      };
      saveWhitelistToFile();
      logger.info(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, service=${serviceArg}`);
      ctx.reply(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, service=${serviceArg}`);
      return;
    }

    if (trimmedText.startsWith('/whitelist_remove')) {
      // e.g. /whitelist_remove 12345
      const parts = trimmedText.split(' ').slice(1);
      if (parts.length < 1) {
        ctx.reply('Usage: /whitelist_remove USER_ID');
        return;
      }
      const [userIdArg] = parts;
      if (userWhitelist[userIdArg]) {
        delete userWhitelist[userIdArg];
        saveWhitelistToFile();
        logger.info(`User ${userIdArg} removed from the whitelist.`);
        ctx.reply(`User ${userIdArg} removed from the whitelist.`);
      } else {
        ctx.reply(`User ${userIdArg} not found in the whitelist.`);
      }
      return;
    }

    if (trimmedText == '/whitelist') {
      // Output JSON of the current list
      const currentList = Object.entries(userWhitelist).map(([id, data]) => ({
        id,
        target_lang: data.target_lang,
        service: data.service
      }));
      ctx.reply(`Current whitelist:\n${JSON.stringify(currentList, null, 2)}`);
      return;
    }
  }

  // -- Translation in Group Chats Only --
  if (chatType && chatType.endsWith('group')) {
    if (userWhitelist[userId]) {
      const { target_lang, service } = userWhitelist[userId];

      try {
        logger.debug(
          `Original message from user ${userId}: "${messageText}"\n` +
          `service=${service}, target_lang=${target_lang}`
        );
        const translated = await translateText(messageText, target_lang, service);

        // Reply to the original message
        await ctx.reply(translated, { reply_to_message_id: ctx.message.message_id });
      } catch (err) {
        logger.error(`Could not translate msg from user ${userId}: ${err.message}`);
        await ctx.reply('Translation failed', { reply_to_message_id: ctx.message.message_id });
      }
    } else {
      logger.info(`User ${userId} is unknown, skipping translation.`);
    }
  }
});

// -- Setup Express Webhook --
const app = express();
app.use(express.json());

// Set the webhook on startup
bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`)
  .then(() => {
    logger.debug(`Webhook set: ${WEBHOOK_URL}/webhook`);
  })
  .catch((err) => {
    logger.error('Error setting webhook:', err);
  });

// Define the webhook endpoint
app.post('/webhook', (req, res) => {
  try {
    bot.handleUpdate(req.body);
    res.sendStatus(200);
  } catch (error) {
    logger.error('Error handling update:', error);
    res.sendStatus(500);
  }
});

// Start the server
app.listen(PORT, () => {
  logger.info(`Bot is serving webhooks on port ${PORT}`);
});
