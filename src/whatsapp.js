import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import fs from "fs/promises";
import path from "path";
import { getState, setWhatsAppState, setWhatsAppClient } from "./runtimeState.js";
import { logger } from "./logger.js";

const { Client, LocalAuth } = pkg;

function getChromiumPath() {
  const configured = String(process.env.CHROME_PATH || '').trim();
  return configured || null;
}

let activeClient = null;
let activeMsgHandler = null;
let initPromise = null;
let relinkInProgress = false;

function getProtocolTimeoutMs() {
  const raw = Number(process.env.WA_PROTOCOL_TIMEOUT_MS || 180000);
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
}

function getBrowserTimeoutMs() {
  const raw = Number(process.env.WA_BROWSER_TIMEOUT_MS || 180000);
  return Number.isFinite(raw) && raw > 0 ? raw : 180000;
}

export async function startWhatsApp({ onMessage }) {
  if (initPromise) {
    logger.warn("⚠️ WhatsApp start requested while init is in progress; reusing existing init promise.");
    return initPromise;
  }

  activeMsgHandler = onMessage;
  const initTask = (async () => {
    logger.info("📌 Initializing WhatsApp client...");
    const chromiumPath = getChromiumPath();
    logger.info("🧭 Chromium path:", chromiumPath || "(bundled Puppeteer Chromium)");

    setWhatsAppState('INITIALIZING');

    const puppeteerArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-zygote",
      "--single-process"
    ];

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: process.env.ACTIVE_SALON_SLUG || "demo-bot",
      }),
      puppeteer: {
        headless: true,
        ...(chromiumPath ? { executablePath: chromiumPath } : {}),
        args: puppeteerArgs,
        timeout: getBrowserTimeoutMs(),
        protocolTimeout: getProtocolTimeoutMs(),
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

    // Retry logic — whatsapp-web.js can hit transient Puppeteer race conditions.
    const MAX_RETRIES = 5;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await client.initialize();
        activeClient = client;
        setWhatsAppClient(client);
        return client;
      } catch (err) {
        const msg = String(err?.message || err || '');
        const isRetryable = /Execution context was destroyed|Protocol error|ProtocolError|timed out|Navigation timeout|Target closed/i.test(msg);

        if (isRetryable && attempt < MAX_RETRIES) {
          logger.warn(`⚠️ WhatsApp init failed (attempt ${attempt}/${MAX_RETRIES}): ${msg}`);
          const waitMs = 5000 * attempt;
          logger.info(`🔄 Retrying in ${Math.round(waitMs / 1000)} seconds...`);
          try { await client.destroy(); } catch { }
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }

        logger.error(`❌ WhatsApp init failed after ${attempt} attempts:`, msg);
        setWhatsAppState('DISCONNECTED');
        try { await client.destroy(); } catch { }
        setWhatsAppClient(null);
        return null;
      }
    }
  })();

  initPromise = initTask.finally(() => {
    initPromise = null;
  });

  return initPromise;
}

export async function relinkWhatsApp() {
  if (relinkInProgress) {
    throw new Error('Relink already in progress');
  }
  relinkInProgress = true;

  logger.info("🔄 Initiating WhatsApp relink process...");
  setWhatsAppState('LINKING');
  const state = getState();
  state.qr = null;
  state.qrUpdatedAt = Date.now();

  try {
    if (activeClient) {
      logger.info("Destroying active WhatsApp client...");
      try {
        await activeClient.destroy();
      } catch (e) {
        logger.error("Failed to cleanly destroy client (maybe already dead):", e.message);
      }
      activeClient = null;
      setWhatsAppClient(null);
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
    return await startWhatsApp({ onMessage: activeMsgHandler });
  } finally {
    relinkInProgress = false;
  }
}
