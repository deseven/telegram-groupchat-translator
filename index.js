require('dotenv').config({ quiet: true });
const fs = require('fs');
const express = require('express');
const { Telegraf } = require('telegraf');
const winston = require('winston');
const OpenAI = require('openai');
const prettyjson = require('prettyjson');

// -- Environment Variables --
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PORT = parseInt(process.env.PORT, 10) || 5005;
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID, 10) || 999999999;
const INTRO = `Hello! This is a private translation bot. If you have admin rights you can use these commands:
  /whitelist - to display current whitelist
  /whitelist_add - to add or edit a user in the whitelist
  /whitelist_remove - to remove a user from the whitelist

Otherwise you can set up your own instance, more info here:
https://github.com/deseven/telegram-groupchat-translator

Your User ID is %USER_ID%.`;

// -- ChatGPT / OpenAI-compatible provider --
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;
const OPENAI_TIMEOUT_MS = parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 60000;
const OPENAI_PROMPT = `You are a helpful AI that translates user messages in the group chat into language code %TARGET_LANG%. Rules:
 - slang and informal wording are acceptable, be casual but precise
 - output only the translated message and nothing else
 - if the text is already in that language, return it as-is`;
const OPENAI_USE_CONTEXT = (process.env.OPENAI_USE_CONTEXT || '').toLowerCase() === 'true';
const OPENAI_CONTEXT_PROMPT = ` - the message is a reply to another message, marked with '[TranslateContext]' and '[EndTranslateContext]', use it to improve the translation`;
const OPENAI_PRONOUNS_PROMPT = ` - user pronouns are %PRONOUNS%, use them to translate with correct gender`;

// -- Retry settings (exponential backoff: 1s, 2s, 4s, ...) --
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES, 10) || 10;
const RETRY_INITIAL_DELAY_MS = parseInt(process.env.RETRY_INITIAL_DELAY_MS, 10) || 1000;

// Telegram message length limit for a single message.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

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
  WEBHOOK_SECRET: obfuscate(WEBHOOK_SECRET),
  PORT,
  LOG_LEVEL,
  ADMIN_USER_ID,
  OPENAI_API_KEY: obfuscate(OPENAI_API_KEY),
  OPENAI_API_ENDPOINT,
  OPENAI_MODEL,
  OPENAI_TEMPERATURE,
  OPENAI_TIMEOUT_MS,
  OPENAI_USE_CONTEXT,
  MAX_RETRIES,
  RETRY_INITIAL_DELAY_MS,
};
logger.info(`=== Startup Settings ===\n${prettyjson.render(envSettings, { noColor: true })}`);

// -- Load Whitelist from whitelist.json --
let userWhitelist = Object.create(null);
try {
  const rawData = fs.readFileSync('./whitelist.json', 'utf-8');
  const data = JSON.parse(rawData);

  if (Array.isArray(data.users)) {
    data.users.forEach(user => {
      const { id, target_lang, service, pronouns, comment } = user;
      if (!id || !target_lang) {
        return;
      }

      // DeepL support has been dropped. Entries explicitly configured for a
      // service other than OpenAI/ChatGPT are ignored so stale configs are
      // handled gracefully instead of silently failing at translation time.
      const normalizedService = (service || '').toLowerCase();
      if (normalizedService && normalizedService !== 'chatgpt') {
        logger.warn(`Skipping whitelist entry for user ${id}: unsupported service "${service}" (only "chatgpt" is supported).`);
        return;
      }

      userWhitelist[id] = {
        target_lang,
        pronouns: pronouns || 'none',
        comment: comment || ''
      };
    });
    logger.info(`Loaded ${Object.keys(userWhitelist).length} whitelisted user(s).`);
  }
} catch (err) {
  logger.error(`Error reading or parsing whitelist.json: ${err.message}`);
}

// -- Helper to Save Whitelist to File --
function saveWhitelistToFile() {
  const usersArray = Object.entries(userWhitelist).map(([id, data]) => ({
    id: Number(id),
    target_lang: data.target_lang,
    pronouns: data.pronouns,
    comment: data.comment
  }));

  const updatedJson = { users: usersArray };

  try {
    fs.writeFileSync('./whitelist.json', JSON.stringify(updatedJson, null, 2), 'utf-8');
    logger.info("Successfully updated whitelist.json");
  } catch (err) {
    logger.error(`Error writing to whitelist.json: ${err.message}`);
  }
}

/**
 * -------------------------
 *   OpenAI/ChatGPT Helper
 * -------------------------
 */
let openaiClient = null;

function getOpenAIClient() {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: OPENAI_API_KEY,
      baseURL: OPENAI_API_ENDPOINT,
      timeout: OPENAI_TIMEOUT_MS,
      // Retries are handled by translateText() with exponential backoff.
      maxRetries: 0
    });
  }
  return openaiClient;
}

async function callChatGPT(text, targetLang, repliedText = '', pronouns = 'none') {
  const openai = getOpenAIClient();

  let prompt = OPENAI_PROMPT.replace('%TARGET_LANG%', targetLang);
  let replyContext = '';

  if (repliedText.trim().length > 0 && OPENAI_USE_CONTEXT === true) {
    prompt = prompt + `\n` + OPENAI_CONTEXT_PROMPT;
    replyContext = `[TranslateContext] ${repliedText} [EndTranslateContext]`;
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
 *   Retry + Backoff Utils
 * -------------------------
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Determines whether an error is worth retrying. Permanent errors (bad API
// key, invalid request, etc.) are surfaced immediately instead of being
// retried 10 times with an ever-growing delay.
function isRetryableError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.httpStatusCode;
  if (typeof status === 'number') {
    if (status === 408 || status === 409 || status === 429) return true;
    if (status >= 500) return true;
    if (status >= 400) return false;
  }

  const code = err?.code;
  if (code && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const name = err?.name || '';
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError' || name === 'AbortError') {
    return true;
  }

  // Unknown errors: retry, preferring availability over speed.
  return true;
}

/**
 * -------------------------
 *  Translate w/ Retry
 *  (exponential backoff: 1s, 2s, 4s, ...)
 * -------------------------
 */
async function translateText(text, targetLang, repliedText = '', pronouns = 'none') {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 1s, 2s, 4s, 8s, ... capped implicitly by MAX_RETRIES.
      const delay = RETRY_INITIAL_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(`Retrying translation in ${delay}ms (retry ${attempt}/${MAX_RETRIES})...`);
      await sleep(delay);
    }

    try {
      logger.debug(`Translation attempt ${attempt + 1}/${MAX_RETRIES + 1}...`);
      return await callChatGPT(text, targetLang, repliedText, pronouns);
    } catch (err) {
      lastError = err;
      logger.error(`Translation attempt ${attempt + 1} failed: ${err.message}`);

      if (attempt === MAX_RETRIES) {
        break;
      }
      if (!isRetryableError(err)) {
        logger.warn('Error is not retryable, aborting retries.');
        break;
      }
    }
  }

  throw lastError || new Error('Unexpected error in translateText()');
}

/**
 * -------------------------
 *  Sequential Message Queue
 * -------------------------
 * All incoming messages are processed strictly one-by-one, in arrival order.
 */
let messageQueue = Promise.resolve();

function processSequentially(task) {
  const run = messageQueue.then(() => task());
  // Keep the chain alive even if a task fails; surface the error for logging.
  messageQueue = run.catch((err) => {
    logger.error(`Queued task failed: ${err && err.stack ? err.stack : err}`);
  });
  return run;
}

// Splits a long string into chunks that respect the Telegram message limit.
function chunkText(text, size = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf('\n', size);
    if (splitAt <= 0) splitAt = size;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

// Helper to obfuscate sensitive strings.
function obfuscate(value) {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

// -- Initialize the Telegraf Bot --
const bot = new Telegraf(BOT_TOKEN);

// -- Unified Message Handler (executed serially via the queue) --
async function handleMessage(ctx) {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const messageText = ctx.message.text || ctx.message.caption;

  logger.info(`Incoming message from user: ${userId}, chat type: ${chatType}`);

  if (!messageText) {
    return;
  }

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
      if (parts.length < 2 || parts.length > 4) {
        logger.debug(`Invalid /whitelist_add command format from admin ${userId}.`);
        return ctx.reply('Usage: /whitelist_add USER_ID TARGET_LANG [PRONOUNS] [COMMENT]');
      }
      const [userIdArg, targetLangArg, pronounsArg = 'none', commentArg = ''] = parts;

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

      // Add/update user in whitelist
      userWhitelist[userIdArg] = {
        target_lang: targetLangArg,
        pronouns: pronounsArg,
        comment: commentArg
      };
      saveWhitelistToFile();
      logger.info(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, pronouns=${pronounsArg}, comment=${commentArg}`);
      return ctx.reply(`User ${userIdArg} added/updated. target_lang=${targetLangArg}, pronouns=${pronounsArg}, comment=${commentArg}`);
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
    if (!userWhitelist[userId]) {
      logger.info(`User ${userId} is unknown, skipping translation.`);
      return;
    }

    const { target_lang, pronouns } = userWhitelist[userId];

    // Grab the text of the message the user is replying to, if any.
    let repliedMessageText = '';
    if (ctx.message.reply_to_message) {
      repliedMessageText = ctx.message.reply_to_message.text
        || ctx.message.reply_to_message.caption
        || '';
      logger.debug(`User ${userId} is replying to a message with text: "${repliedMessageText}"`);
    }

    try {
      logger.debug(
        `Original message from user ${userId}: "${messageText}"\n` +
        `target_lang=${target_lang}, pronouns=${pronouns}`
      );

      const translated = await translateText(messageText, target_lang, repliedMessageText, pronouns);

      logger.debug(`Translated message:\n"${translated}"`);

      if (translated == messageText) {
        logger.debug('Skipping translation because translated text is the same.');
        return;
      }

      // Reply to the original message, splitting if it exceeds Telegram's limit.
      const chunks = chunkText(translated);
      for (let i = 0; i < chunks.length; i++) {
        const options = i === 0 ? { reply_to_message_id: ctx.message.message_id } : undefined;
        await ctx.reply(chunks[i], options);
      }
    } catch (err) {
      logger.error(`Could not translate msg from user ${userId}: ${err.message}`);
      logger.debug(`Error details: ${err.stack}`);
      await ctx.reply('Translation failed', { reply_to_message_id: ctx.message.message_id });
    }
  }
}

bot.on('message', (ctx) => processSequentially(() => handleMessage(ctx)));

// -- Error handling --
process.on('unhandledRejection', (reason) => {
  // Do not exit: a single failed update must not take the whole bot down.
  logger.error(`Unhandled Rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception thrown: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});

bot.catch((err) => {
  logger.error(`Global Telegraf error: ${err && err.stack ? err.stack : err}`);
});

// -- Setup Express Webhook --
const app = express();
app.use(express.json());

// Set the webhook on startup
const webhookOptions = WEBHOOK_SECRET ? { secret_token: WEBHOOK_SECRET } : undefined;
bot.telegram.setWebhook(`${WEBHOOK_URL}/webhook`, webhookOptions)
  .then(() => {
    logger.debug(`Webhook set: ${WEBHOOK_URL}/webhook`);
  })
  .catch((err) => {
    logger.error(`Error setting webhook: ${err.message}`);
  });

// Define the webhook endpoint
app.post('/webhook', (req, res) => {
  if (WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    logger.warn('Rejected webhook request with invalid secret token.');
    return res.sendStatus(401);
  }

  // Acknowledge immediately; processing happens asynchronously (and serially).
  res.sendStatus(200);
  bot.handleUpdate(req.body).catch((err) => {
    logger.error(`Error handling update: ${err && err.stack ? err.stack : err}`);
  });
});

// Health check
app.get('/health', (req, res) => {
  res.send('OK');
});

// -- Start the server --
app.listen(PORT, () => {
  logger.info(`Bot started successfully!`);
});
