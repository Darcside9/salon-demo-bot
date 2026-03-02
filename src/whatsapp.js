import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs/promises";
import path from "path";
import { getState, setWhatsAppState } from "./runtimeState.js";
import { logger } from "./logger.js";

const { Client, LocalAuth } = pkg;

function getChromiumPath() {
  return process.env.CHROME_PATH || "/usr/bin/google-chrome";
}

let activeClient = null;
let activeMsgHandler = null;

export function startWhatsApp({ onMessage }) {
  activeMsgHandler = onMessage;
  logger.info("📌 Initializing WhatsApp client...");
  logger.info("🧭 Chromium path:", getChromiumPath());

  setWhatsAppState('INITIALIZING');

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: process.env.ACTIVE_SALON_SLUG || "demo-bot",
    }),
    puppeteer: {
      headless: true,
      executablePath: getChromiumPath(),
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-first-run",
        "--no-zygote",
      ],
      timeout: 60000,
    },
  });

  client.on("loading_screen", (percent, message) => {
    setWhatsAppState('LOADING');
    logger.info(`📲 Loading WhatsApp: ${percent}% - ${message}`);
  });

  client.on("qr", (qr) => {
    const state = getState();
    state.qr = qr;
    state.qrUpdatedAt = Date.now();
    setWhatsAppState('NEEDS_LINK');

    logger.info("\n📱 Scan this QR with the salon WhatsApp account:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    const state = getState();
    state.qr = null;
    setWhatsAppState('READY');
    logger.info("✅ WhatsApp client ready");
  });

  client.on("authenticated", () => {
    setWhatsAppState('AUTHENTICATED');
    logger.info("✅ WhatsApp authenticated");
  });

  client.on("auth_failure", (msg) => {
    setWhatsAppState('AUTH_FAILURE');
    logger.error("❌ Auth failure:", msg);
  });

  client.on("disconnected", (reason) => {
    setWhatsAppState('DISCONNECTED');
    logger.error("⚠️ WhatsApp disconnected:", reason);
  });

  client.on("change_state", (stateMsg) => {
    logger.info("ℹ️ WhatsApp state changed:", stateMsg);
  });

  client.on("message", async (msg) => {
    try {
      await onMessage(msg, client);
    } catch (err) {
      logger.error("❌ Message handler error:", err);

      const from = String(msg.from || '').replace('@c.us', '').replace('@g.us', '');
      const isOwner = from === String(process.env.OWNER_NUMBER || '').trim();

      try {
        if (isOwner) {
          await msg.reply(`Dev error: ${err?.message || 'Unknown error'}`);
        } else {
          await msg.reply('Sorry, I hit an error. Please try again.');
        }
      } catch { }
    }
  });

  logger.info("🚀 Calling client.initialize()...");

  // Retry logic — whatsapp-web.js can hit a ProtocolError race condition
  // during page navigation in Puppeteer. Retrying usually fixes it.
  const MAX_RETRIES = 3;
  (async () => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.initialize();
        break; // success
      } catch (err) {
        const isRetryable = err.message?.includes('Execution context was destroyed')
          || err.message?.includes('Protocol error');
        if (isRetryable && attempt < MAX_RETRIES) {
          logger.warn(`⚠️ WhatsApp init failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
          logger.info(`🔄 Retrying in 3 seconds...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          logger.error(`❌ WhatsApp init failed after ${attempt} attempts:`, err.message);
          setWhatsAppState('ERROR');
          throw err;
        }
      }
    }
  })();

  activeClient = client;
  return client;
}

export async function relinkWhatsApp() {
  logger.info("🔄 Initiating WhatsApp relink process...");
  setWhatsAppState('LINKING');

  if (activeClient) {
    logger.info("Destroying active WhatsApp client...");
    try {
      await activeClient.destroy();
    } catch (e) {
      logger.error("Failed to cleanly destroy client (maybe already dead):", e.message);
    }
    activeClient = null;
  }

  // Wipe Auth Folder safely
  const authDir = path.join(process.cwd(), '.wwebjs_auth');
  const cacheDir = path.join(process.cwd(), '.wwebjs_cache');

  try {
    await fs.rm(authDir, { recursive: true, force: true });
    logger.info(`🗑️ Cleared auth directory: ${authDir}`);
  } catch (e) {
    logger.warn(`Could not clear auth dir: ${e.message}`);
  }

  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
    logger.info(`🗑️ Cleared cache directory: ${cacheDir}`);
  } catch (e) {
    logger.warn(`Could not clear cache dir: ${e.message}`);
  }

  logger.info("🚀 Starting fresh WhatsApp client...");
  return startWhatsApp({ onMessage: activeMsgHandler });
}
