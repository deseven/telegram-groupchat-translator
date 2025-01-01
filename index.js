require('dotenv').config();
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const axios = require('axios');
const OpenAI = require('openai');
const prettyjson = require('prettyjson');

// -- Environment Variables --
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = parseInt(process.env.PORT,10) || 5005;
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID,10) || 999999999;
const INTRO = `Hello! This is a private translation bot. If you have admin rights you can use these commands:
  /whitelist - to display current whitelist
  /whitelist_add - to add or edit a user in the whitelist
  /whitelist_remove - to remove a user from the whitelist

Otherwise you can set up your own instance, more info here:
https://github.com/deseven/telegram-groupchat-translator

Your User ID is %USER_ID%.`;

// -- DeepL --
const DEEPL_AUTH_KEY = process.env.DEEPL_AUTH_KEY;

// -- ChatGPT --
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;
const OPENAI_PROMPT = `You are a helpful AI that translates user messages into language code %TARGET_LANG%. Rules:
 - slang and informal wording are acceptable, be casual but precise
 - output only the translated message and nothing else
 - if the text is already in that language, return it as-is`;
const OPENAI_USE_CONTEXT = (process.env.OPENAI_USE_CONTEXT || '').toLowerCase() === 'true';
const OPENAI_CONTEXT_PROMPT = ` - the message is a reply to another message, marked with '[TranslateContext]' and '[EndTranslateContext]', use it to improve the translation`;
const OPENAI_PRONOUNS_PROMPT = ` - user pronouns are %PRONOUNS%, use them to translate with correct gender`;

// -- Winston Logger --
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.align(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] [${level}]: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

logger.info('Bot is starting up...');

// -- Display settings on startup --
const envSettings = {
  BOT_TOKEN: obfuscate(BOT_TOKEN),
  WEBHOOK_URL,
  PORT,
  LOG_LEVEL,
  ADMIN_USER_ID,
  DEEPL_AUTH_KEY: obfuscate(DEEPL_AUTH_KEY),
  OPENAI_API_KEY: obfuscate(OPENAI_API_KEY),
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  OPENAI_USE_CONTEXT,
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(envSettings,{noColor: true})}`);

// -- Load Whitelist from whitelist.json --
let userWhitelist = {};
try {
  const rawData = fs.readFileSync('./whitelist.json', 'utf-8');
  const data = JSON.parse(rawData);

  if (Array.isArray(data.users)) {
    data.users.forEach(user => {
      const { id, target_lang, service, pronouns, comment } = user;
      if (id && target_lang && service) {
        userWhitelist[id] = {
          target_lang,
          service: service.toLowerCase(),
          pronouns: pronouns || 'none',
          comment: comment || ''
        };
      }
    });
    logger.info(`Loaded ${Object.keys(userWhitelist).length} whitelisted user(s).`);
  }
} catch (err) {
  logger.error("Error reading or parsing whitelist.json:", err);
}

// -- Helper to Save Whitelist to File --
function saveWhitelistToFile() {
  const usersArray = Object.entries(userWhitelist).map(([id, data]) => ({
    id: Number(id),
    target_lang: data.target_lang,
    service: data.service,
    pronouns: data.pronouns,
    comment: data.comment
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

  if (response.data?.translations?.[0]?.text) {
    return response.data.translations[0].text;
  }

  throw new Error('Invalid DeepL response format');
}

/**
 * -------------------------
 *       ChatGPT Helper
 * -------------------------
 */
async function callChatGPT(text, targetLang, repliedText = '', pronouns = 'none') {
  const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_API_ENDPOINT
  });

  let prompt = OPENAI_PROMPT.replace('%TARGET_LANG%', targetLang);
  let replyContext = '';

  if (repliedText.trim().length > 0 && OPENAI_USE_CONTEXT === true) {
    prompt = prompt + `\n` + OPENAI_CONTEXT_PROMPT;
    replyContext = `[TranslateContext] ${repliedText} [EndTranslateContext]`; // Assign value here
  }

  if (pronouns !== 'none') {
    prompt = prompt + `\n` + OPENAI_PRONOUNS_PROMPT.replace('%PRONOUNS%', pronouns);
  }

  logger.debug(`Prompt:\n${prompt}`);

  const messages = [
    {
      role: 'system',
      content: prompt
    }
  ];

  if (repliedText.trim().length > 0 && OPENAI_USE_CONTEXT === true) {
    messages.push({
      role: 'user',
      content: replyContext
    });
    logger.debug(`Context:\n${replyContext}`);
  }

  messages.push({
    role: 'user',
    content: text
  });

  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: messages,
    temperature: OPENAI_TEMPERATURE
  });

  if (response.choices?.[0]?.message?.content) {
    return response.choices[0].message.content.trim();
  }

  throw new Error('Invalid ChatGPT response format');
}

/**
 * -------------------------
 *  Translate w/ Retry (3x)
 * -------------------------
 */
async function translateText(text, targetLang, service, repliedText = '', pronouns = 'none') {
  const MAX_TRIES = 3;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      logger.debug(`Attempt ${attempt}/${MAX_TRIES} for ${service.toUpperCase()} translation...`);

      if (service === 'deepl') {
        return await callDeepL(text, targetLang);
      } else if (service === 'chatgpt') {
        return await callChatGPT(text, targetLang, repliedText, pronouns);
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
  throw new Error('Unexpected error in translateText()');
}

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
  if (!value) return ''; // Return empty for missing/undefined
  // Keep the first few characters and last few characters visible
  // (adjust to your preference).
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// -- Unified Message Handler --
bot.on('message', async (ctx) => {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const messageText = ctx.message.text || ctx.message.caption;

  logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

  if (messageText) {
    const trimmedText = messageText.trim();

    // Handle /start or /help command
    if ((chatType === 'private') && (trimmedText == '/start' || trimmedText == '/help')) {
      logger.info(`Received "${trimmedText}" from user ${userId} in private chat.`);
      logger.debug(`Sending intro message to user ${userId}.`);
      return ctx.reply(INTRO.replace('%USER_ID%', userId));
    }

    // Admin Commands (Private Chat)
    if (chatType === 'private' && String(userId) === String(ADMIN_USER_ID)) {
      if (trimmedText.startsWith('/whitelist_add')) {
        const parts = trimmedText.split(' ').slice(1);
        if (parts.length < 3 || parts.length > 5) {
          logger.debug(`Invalid /whitelist_add command format from admin ${userId}.`);
          return ctx.reply('Usage: /whitelist_add USER_ID TARGET_LANG SERVICE [PRONOUNS] [COMMENT]');
        }
        const [userIdArg, targetLangArg, serviceArg, pronounsArg = 'none', commentArg = ''] = parts;

        // Validate USER_ID (numeric)
        if (!/^\d+$/.test(userIdArg)) {
          logger.debug(`Invalid USER_ID format from admin ${userId}: ${userIdArg}`);
          return ctx.reply('Error: USER_ID must be numeric.');
        }

        // Validate TARGET_LANG (letters with optional hyphen)
        if (!/^[a-zA-Z-]+$/.test(targetLangArg)) {
          logger.debug(`Invalid TARGET_LANG format from admin ${userId}: ${targetLangArg}`);
          return ctx.reply('Error: TARGET_LANG must contain only letters and hyphens.');
        }

        // Validate SERVICE (either "chatgpt" or "deepl")
        const normalizedServiceArg = serviceArg.toLowerCase();
        if (normalizedServiceArg !== 'chatgpt' && normalizedServiceArg !== 'deepl') {
          logger.debug(`Invalid SERVICE format from admin ${userId}: ${serviceArg}`);
          return ctx.reply('Error: SERVICE must be either "chatgpt" or "deepl".');
        }

        // Add/update user in whitelist
        userWhitelist[userIdArg] = {
          target_lang: targetLangArg,
          service: normalizedServiceArg,
          pronouns: pronounsArg,
          comment: commentArg
        };
        saveWhitelistToFile();
        logger.info(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, service=${normalizedServiceArg}, pronouns=${pronounsArg}, comment=${commentArg}`);
        logger.debug(`Whitelist updated for user ${userIdArg}.`);
        return ctx.reply(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, service=${normalizedServiceArg}, pronouns=${pronounsArg}, comment=${commentArg}`);
      }

      if (trimmedText.startsWith('/whitelist_remove')) {
        const parts = trimmedText.split(' ').slice(1);
        if (parts.length !== 1) {
          logger.debug(`Invalid /whitelist_remove command format from admin ${userId}.`);
          return ctx.reply('Usage: /whitelist_remove USER_ID');
        }
        const [userIdArg] = parts;
        if (userWhitelist[userIdArg]) {
          delete userWhitelist[userIdArg];
          saveWhitelistToFile();
          logger.info(`User ${userIdArg} removed from the whitelist.`);
          logger.debug(`Whitelist updated after removing user ${userIdArg}.`);
          return ctx.reply(`User ${userIdArg} removed from the whitelist.`);
        } else {
          logger.debug(`User ${userIdArg} not found in the whitelist by admin ${userId}.`);
          return ctx.reply(`User ${userIdArg} not found in the whitelist.`);
        }
      }

      if (trimmedText === '/whitelist') {
        const currentList = Object.entries(userWhitelist).map(([id, data]) => ({
          id,
          target_lang: data.target_lang,
          service: data.service,
          pronouns: data.pronouns,
          comment: data.comment
        }));
        logger.debug(`Admin ${userId} requested the current whitelist.`);
        return ctx.reply(`Current whitelist:\n\`\`\`\n${prettyjson.render(currentList, { noColor: true })}\n\`\`\``, { parse_mode: 'Markdown' });
      }
    }

    // Translation in Group Chats Only
    if (chatType && chatType.endsWith('group')) {
      // Ignore commands
      if (trimmedText.startsWith('/')) {
        logger.debug('Skipping translation for a command.');
        return;
      }
      if (userWhitelist[userId]) {
        const { target_lang, service, pronouns } = userWhitelist[userId];

        // Grab the text of the message the user is replying to, if any.
        let repliedMessageText = '';
        if (ctx.message.reply_to_message) {
          // It could be text or a caption (for photos, etc.)
          repliedMessageText = ctx.message.reply_to_message.text
            || ctx.message.reply_to_message.caption
            || '';
          logger.debug(`User ${userId} is replying to a message with text: "${repliedMessageText}"`);
        }

        try {
          logger.debug(
            `Original message from user ${userId}: "${messageText}"\n` +
            `service=${service}, target_lang=${target_lang}, pronouns=${pronouns}`
          );

          const translated = await translateText(messageText, target_lang, service, repliedMessageText, pronouns);

          logger.debug(`Translated message:\n"${translated}"`);

          if (translated == messageText) {
            logger.debug('Skipping translation because translated text is the same.');
            return;
          }

          // Reply to the original message
          logger.debug(`Replying with translated message to user ${userId}.`);
          await ctx.reply(translated, { reply_to_message_id: ctx.message.message_id });
        } catch (err) {
          logger.error(`Could not translate msg from user ${userId}: ${err.message}`);
          logger.debug(`Error details: ${err.stack}`);
          await ctx.reply('Translation failed', { reply_to_message_id: ctx.message.message_id });
        }
      } else {
        logger.info(`User ${userId} is unknown, skipping translation.`);
        logger.debug(`User ${userId} is not in the whitelist.`);
      }
    }
  }
});

// -- Error handling --
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception thrown:', err);
  process.exit(2);
});

bot.catch((err, ctx) => {
  logger.error('Global Telegraf error:', err);
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

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

// -- Start the server --
app.listen(PORT, () => {
  logger.info(`Bot started successfully!`);
});
