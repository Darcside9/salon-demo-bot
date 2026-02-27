import pkg from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const { Client, LocalAuth } = pkg;

function getChromiumPath() {
  return process.env.CHROME_PATH || "/usr/bin/google-chrome";
}

export function startWhatsApp({ onMessage }) {
  console.log("📌 Initializing WhatsApp client...");
  console.log("🧭 Chromium path:", getChromiumPath());

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
    console.log(`📲 Loading WhatsApp: ${percent}% - ${message}`);
  });

  client.on("qr", (qr) => {
    console.log("\n📱 Scan this QR with the salon WhatsApp account:\n");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    console.log("✅ WhatsApp client ready");
  });

  client.on("authenticated", () => {
    console.log("✅ WhatsApp authenticated");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Auth failure:", msg);
  });

  client.on("disconnected", (reason) => {
    console.error("⚠️ WhatsApp disconnected:", reason);
  });

  client.on("change_state", (state) => {
    console.log("ℹ️ WhatsApp state changed:", state);
  });

  client.on("message", async (msg) => {
    try {
      await onMessage(msg, client);
    } catch (err) {
      console.error("❌ Message handler error:", err);

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

  console.log("🚀 Calling client.initialize()...");

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
          console.warn(`⚠️ WhatsApp init failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
          console.log(`🔄 Retrying in 3 seconds...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          console.error(`❌ WhatsApp init failed after ${attempt} attempts:`, err.message);
          throw err;
        }
      }
    }
  })();

  return client;
}
