import 'dotenv/config';
import express from 'express';
import { startWhatsApp } from './whatsapp.js';
import { parseCommand, helpText } from './commands.js';
import { askLLM } from './llm.js';
import { setupDashboard } from './dashboard.js';
import {
  getSalonBySlug,
  getActiveConfig,
  getConvoMode,
  setConvoMode,
  getTodayUsage,
  incrementDailyUsage,
  approveLatestDraft,
  rollbackToVersion,
  createDraftConfig,
  getAllSalons,
  getWhitelist
} from './salonStore.js';
import { proposeKnowledgeUpdate } from './websiteImport.js';
import { normalizeNumber, isOwner, isCommand, canUseAutomationForChat } from './guardrails.js';
import { logMessage } from './messageStore.js';
import { createHandoverRequest, resolveOpenRequestsForCustomer } from './handoverStore.js';
import { detectTrigger, HANDOVER_WAITING_MESSAGE } from './triggerEngine.js';
import { sendTelegramAlert } from './notifier.js';
import { logger } from './logger.js';
import {
  getState, setSalon, setConfig, setWhatsAppState,
  setWhatsAppClient, setAutomation, pushError,
  setAllSalons, setAdminWhitelist
} from './runtimeState.js';

const DAILY_MESSAGE_CAP = 300;
const DAILY_TOKEN_CAP = 120000;

function buildSystemPrompt({ salon, config }) {
  const faq = Array.isArray(config.faq_json) ? config.faq_json : [];
  const faqBlock = faq.length
    ? faq.map((item, i) => `${i + 1}. Q: ${item.q}\n   A: ${item.a}`).join('\n')
    : 'No FAQ loaded.';

  return `${config.soul_md}

# FAQ KNOWLEDGE
${faqBlock}

# BOT BEHAVIOR
- Keep replies short and practical.
- If user asks for appointment booking, collect details and say staff will confirm.
- If unsure, do not invent details.

# LANGUAGE
- Always detect and respond in the customer's language.
- If they write in Chinese, respond in Chinese. If in French, respond in French. Etc.
- Use the FAQ answers as your knowledge source, but translate your response to match the customer's language.

# HANDOVER SIGNAL
If you determine the customer needs a human (booking confirmation, complaint, refund, unclear request, or they explicitly ask for a person), you MUST prefix your entire response with [HANDOVER] followed by your customer-facing reply.
Example: [HANDOVER] Thanks — I'm handing this over to a staff member now. They'll reply shortly.
Only use [HANDOVER] when escalation is truly needed. Normal questions should be answered directly.
`;
}

function findFaqAnswer(text, faqJson) {
  if (!Array.isArray(faqJson)) return null;
  const q = String(text || '').toLowerCase();

  for (const item of faqJson) {
    const faqQ = String(item?.q || '').toLowerCase();
    if (!faqQ) continue;

    const words = faqQ.split(/\W+/).filter(w => w.length > 3);
    const score = words.reduce((acc, w) => (q.includes(w) ? acc + 1 : acc), 0);

    if (score >= Math.max(1, Math.ceil(words.length * 0.4))) {
      return item.a;
    }
  }

  return null;
}

function getSimpleGreetingReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[!?.]+$/g, '');
  if (!t) return null;

  const greetings = ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening'];
  if (greetings.includes(t)) {
    return 'Hi 👋 Welcome to Demo Salon 1. How can I help you today? You can ask about opening hours, services, or appointments.';
  }

  // Thanks / appreciation — keyword match (catches "alright thanks", "ok thank you", etc.)
  const thanksWords = ['thanks', 'thank you', 'thank u', 'thx', 'ty', 'appreciated'];
  if (thanksWords.some(w => t.includes(w))) {
    return 'You\'re welcome! 😊 Let me know if there\'s anything else I can help with.';
  }

  // Farewell — keyword match
  const byeWords = ['bye', 'goodbye', 'see you', 'see ya', 'take care', 'gotta go', 'ciao'];
  if (byeWords.some(w => t.includes(w))) {
    return 'Goodbye! 👋 Have a great day. Feel free to message us anytime.';
  }

  // Simple acknowledgements — exact match only (these are short enough)
  const acks = ['ok', 'okay', 'alright', 'cool', 'sure', 'got it', 'noted', 'great', 'nice', 'perfect', 'awesome', 'sounds good'];
  if (acks.includes(t)) {
    return 'Great! Let me know if you need anything else. 😊';
  }

  return null;
}

async function reloadSalonConfig() {
  const salon = await getSalonBySlug(process.env.ACTIVE_SALON_SLUG);
  const config = await getActiveConfig(salon.id);
  setSalon(salon);
  setConfig(config);
  return { salon, config };
}

/**
 * Initiate handover: create request, update convo mode, notify, send waiting message.
 */
async function initiateHandover({ salonId, customerId, reason, messageText, msg }) {
  try {
    await setConvoMode(salonId, customerId, 'handover_requested');
    await createHandoverRequest({ salonId, customerId, reason, latestMessage: messageText });

    // Send waiting message to customer
    await msg.reply(HANDOVER_WAITING_MESSAGE);

    // Log the system waiting message
    await logMessage({
      salonId, customerId,
      direction: 'outbound', source: 'system',
      text: HANDOVER_WAITING_MESSAGE
    });

    // Fire Telegram alert (async, don't block)
    sendTelegramAlert({ salonId, customerId, reason, message: messageText }).catch(err => {
      logger.error('Telegram alert error:', err.message);
    });

    logger.info(`🔔 Handover initiated for ${customerId} — reason: ${reason}`);
  } catch (err) {
    logger.error('Handover initiation error:', err.message);
    pushError(err);
  }
}

async function handleAdminCommand({ msg, command, fromNumber, resolvedPhone }) {
  const { cmd } = command;
  const state = getState();

  // Check both the normalized raw ID and the resolved phone number
  if (!isOwner(fromNumber) && !(resolvedPhone && isOwner(resolvedPhone))) {
    logger.info(`🚫 Admin rejected: normalized=${fromNumber} resolved=${resolvedPhone}`);
    return false; // not admin, let it fall through to customer handling
  }

  switch (cmd) {
    case '/help':
      await msg.reply(helpText());
      return true;

    case '/status': {
      const usage = await getTodayUsage(state.salon.id);
      const activeMode = await getConvoMode(state.salon.id, normalizeNumber(msg.from));
      await msg.reply(
        [
          '📊 *Bot Status*',
          `Salon: ${state.salon.name} (${state.salon.slug})`,
          `Automation: ${state.automationEnabled ? 'ENABLED' : 'DISABLED'}`,
          `Current chat mode: ${activeMode.toUpperCase()}`,
          `SOUL version: ${state.config.version}`,
          `Today messages: ${usage.messages || 0}/${DAILY_MESSAGE_CAP}`,
          `Today tokens: ${usage.tokens || 0}/${DAILY_TOKEN_CAP}`
        ].join('\n')
      );
      return true;
    }

    case '/enable':
      setAutomation(true);
      await msg.reply('✅ Automation enabled.');
      return true;

    case '/disable':
      setAutomation(false);
      await msg.reply('⏸ Automation disabled.');
      return true;

    case '/reload': {
      await reloadSalonConfig();
      const s = getState();
      await msg.reply(`🔄 Reloaded active config (SOUL v${s.config.version}).`);
      return true;
    }

    case '/takeover': {
      const customerId = normalizeNumber(msg.from);
      await setConvoMode(state.salon.id, customerId, 'human');
      await msg.reply('🧑‍💼 Handover enabled for this chat. Bot will stay silent.');
      return true;
    }

    case '/resume': {
      const customerId = normalizeNumber(msg.from);
      await setConvoMode(state.salon.id, customerId, 'bot');
      await resolveOpenRequestsForCustomer(state.salon.id, customerId);
      await msg.reply('🤖 Automation resumed for this chat.');
      return true;
    }

    case '/soul':
    case '/faq':
      await msg.reply('ℹ️ SOUL and FAQ preview is available in the Dashboard only.\nOpen http://localhost:' + (process.env.PORT || 3000));
      return true;

    case '/import': {
      const url = command.args[0];
      if (!url) {
        await msg.reply('Usage: /import <url>');
        return true;
      }
      await msg.reply('⏳ Importing website... this may take a moment.');
      try {
        const proposal = await proposeKnowledgeUpdate(url);
        await createDraftConfig({
          salonId: state.salon.id,
          soulMd: proposal.proposed.soul_md,
          faqJson: proposal.proposed.faq_json,
          createdBy: `import:${url}`
        });
        const faqPreview = proposal.proposed.faq_json
          .slice(0, 5)
          .map((f, i) => `${i + 1}. Q: ${f.q}\n   A: ${f.a}`)
          .join('\n');
        await msg.reply(
          `✅ *Import complete*\n` +
          `Source: ${proposal.extracted.title}\n` +
          `Generated ${proposal.proposed.faq_json.length} FAQ entries\n\n` +
          `*Preview (first 5):*\n${faqPreview}\n\n` +
          `Draft saved. Use /approve to activate.`
        );
      } catch (err) {
        await msg.reply(`❌ Import failed: ${err.message}`);
      }
      return true;
    }

    case '/approve': {
      try {
        const activated = await approveLatestDraft(state.salon.id);
        await reloadSalonConfig();
        await msg.reply(`✅ Draft approved and activated (v${activated.version}). Config reloaded.`);
      } catch (err) {
        await msg.reply(`❌ Approve failed: ${err.message}`);
      }
      return true;
    }

    case '/rollback': {
      const version = parseInt(command.args[0], 10);
      if (!version || isNaN(version)) {
        await msg.reply('Usage: /rollback <version>');
        return true;
      }
      try {
        const restored = await rollbackToVersion(state.salon.id, version);
        await reloadSalonConfig();
        await msg.reply(`✅ Rolled back to v${restored.version}. Config reloaded.`);
      } catch (err) {
        await msg.reply(`❌ Rollback failed: ${err.message}`);
      }
      return true;
    }

    default:
      return false;
  }
}

async function handleCustomerMessage(msg) {
  // Ignore status broadcasts (WhatsApp Stories/statuses)
  if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

  const state = getState();
  if (!state.automationEnabled) return;

  const chat = await msg.getChat();
  if (!canUseAutomationForChat({ isGroup: chat.isGroup })) return;

  const customerId = normalizeNumber(msg.from);
  const text = (msg.body || '').trim();
  if (!text) return;

  // Log inbound message
  await logMessage({
    salonId: state.salon.id,
    customerId,
    waMessageId: msg.id?._serialized,
    direction: 'inbound',
    source: 'customer',
    text
  });

  // Check conversation mode
  const mode = await getConvoMode(state.salon.id, customerId);
  if (mode === 'human' || mode === 'handover_requested') {
    return; // silent during handover
  }

  // Usage cap check
  const usage = await getTodayUsage(state.salon.id);
  if ((usage.messages || 0) >= DAILY_MESSAGE_CAP || (usage.tokens || 0) >= DAILY_TOKEN_CAP) {
    const capMsg = 'We are receiving high traffic right now. Please wait a moment or contact staff directly.';
    await msg.reply(capMsg);
    await logMessage({ salonId: state.salon.id, customerId, direction: 'outbound', source: 'system', text: capMsg });
    return;
  }

  // Trigger engine — check for handover triggers BEFORE FAQ/LLM
  const trigger = detectTrigger(text);
  if (trigger.triggered) {
    await initiateHandover({
      salonId: state.salon.id,
      customerId,
      reason: trigger.reason,
      messageText: text,
      msg
    });
    await incrementDailyUsage({ salonId: state.salon.id, tokens: 0, costEst: 0 });
    return;
  }

  // Greeting shortcut
  const greetingReply = getSimpleGreetingReply(text);
  if (greetingReply) {
    await incrementDailyUsage({ salonId: state.salon.id, tokens: 0, costEst: 0 });
    await msg.reply(greetingReply);
    await logMessage({ salonId: state.salon.id, customerId, direction: 'outbound', source: 'bot', text: greetingReply });
    return;
  }

  // FAQ first
  const faqAnswer = findFaqAnswer(text, state.config.faq_json);
  if (faqAnswer) {
    await incrementDailyUsage({ salonId: state.salon.id, tokens: 0, costEst: 0 });
    const reply = String(faqAnswer);
    await msg.reply(reply);
    await logMessage({ salonId: state.salon.id, customerId, direction: 'outbound', source: 'bot', text: reply });
    return;
  }

  // LLM fallback
  const system = buildSystemPrompt({ salon: state.salon, config: state.config });
  const llm = await askLLM({ system, user: text });

  // If LLM failed, trigger handover instead of sending a broken fallback
  if (llm.providerError) {
    await initiateHandover({
      salonId: state.salon.id,
      customerId,
      reason: 'llm_failure',
      messageText: text,
      msg
    });
    await incrementDailyUsage({ salonId: state.salon.id, tokens: 0, costEst: 0 });
    return;
  }

  // Check if LLM signals handover intent (multilingual — works in any language)
  let replyText = llm.text;
  if (replyText.startsWith('[HANDOVER]')) {
    replyText = replyText.replace(/^\[HANDOVER\]\s*/i, '').trim();
    await incrementDailyUsage({ salonId: state.salon.id, tokens: llm.tokens || 0, costEst: llm.costEst || 0 });
    await initiateHandover({
      salonId: state.salon.id,
      customerId,
      reason: 'llm_detected',
      messageText: text,
      msg
    });
    return;
  }

  await incrementDailyUsage({
    salonId: state.salon.id,
    tokens: llm.tokens || 0,
    costEst: llm.costEst || 0
  });

  await msg.reply(replyText);
  await logMessage({ salonId: state.salon.id, customerId, direction: 'outbound', source: 'bot', text: replyText });
}

async function onMessage(msg) {
  const text = (msg.body || '').trim();
  if (!text) return;

  const fromRaw = msg.from;
  let fromNumber = normalizeNumber(fromRaw);

  // Resolve phone number from contact (WhatsApp LID IDs don't contain the phone number)
  let resolvedPhone = null;
  try {
    const contact = await msg.getContact();
    resolvedPhone = contact?.number || contact?.id?.user || null;
  } catch { /* ignore contact lookup failure */ }

  logger.info(`📨 msg.from=${fromRaw}  normalized=${fromNumber}  contact.number=${resolvedPhone}  text="${text.slice(0, 50)}"`);

  // owner commands — check both normalized ID and resolved phone against whitelist
  if (isCommand(text)) {
    const command = parseCommand(text);
    const handled = await handleAdminCommand({ msg, command, fromNumber, resolvedPhone });
    if (handled) return;
  }

  await handleCustomerMessage(msg);
}

async function boot() {
  logger.info('🚀 Starting salon demo bot...');

  // Load salon config
  const { salon, config } = await reloadSalonConfig();
  logger.info(`✅ Loaded salon: ${salon.name} (${salon.slug})`);
  logger.info(`✅ Active SOUL version: ${config.version}`);

  // Load all salons for dashboard switching
  const allSalons = await getAllSalons();
  setAllSalons(allSalons);
  logger.info(`✅ Available salons: ${allSalons.map(s => s.slug).join(', ')}`);

  // Load admin whitelist
  const whitelist = await getWhitelist();
  setAdminWhitelist(whitelist);
  logger.info(`✅ Admin whitelist: ${whitelist.filter(w => w.is_active).length} active admin(s)`);

  // Express + Dashboard
  const app = express();
  app.use(express.json());

  setupDashboard({ app, reloadConfig: reloadSalonConfig });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    logger.info(`📊 Dashboard: http://localhost:${port}`);
  });

  // WhatsApp
  const client = await startWhatsApp({ onMessage });
  setWhatsAppClient(client);
  client.on('ready', () => { setWhatsAppState('ready'); });
  client.on('authenticated', () => { setWhatsAppState('authenticated'); });
  client.on('auth_failure', () => { setWhatsAppState('auth_failure'); });
  client.on('disconnected', () => { setWhatsAppState('disconnected'); });
}

boot().catch((err) => {
  console.error('❌ Startup error:', err);
  process.exit(1);
});
