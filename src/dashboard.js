import express from 'express';
import { getState, setAutomation, getWhatsAppClient, setSalon, setConfig, setAllSalons, setAdminWhitelist } from './runtimeState.js';
import {
  getTodayUsage, getConvoMode, setConvoMode,
  getSalonBySlug, getActiveConfig, getAllSalons,
  getWhitelist, addToWhitelist, removeFromWhitelist,
  getLatestDraftConfig, createDraftConfig, approveLatestDraft, rollbackToVersion
} from './salonStore.js';
import { getHandoverQueue, claimHandoverRequest, resolveHandoverRequest, resolveOpenRequestsForCustomer } from './handoverStore.js';
import { getRecentChats, getCustomerMessages, logMessage } from './messageStore.js';
import { proposeKnowledgeUpdate } from './websiteImport.js';

// ─── In-memory log ring buffer ──────────────────────────────
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];

function captureLog(level, args) {
  logBuffer.push({
    ts: new Date().toISOString(),
    level,
    msg: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

function installLogCapture() {
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.log = (...args) => { captureLog('info', args); origLog(...args); };
  console.error = (...args) => { captureLog('error', args); origErr(...args); };
  console.warn = (...args) => { captureLog('warn', args); origWarn(...args); };
}

// ─── Dashboard setup ────────────────────────────────────────
export function setupDashboard({ app, reloadConfig }) {
  installLogCapture();

  // ── Existing API routes ──
  app.get('/api/status', async (_req, res) => {
    try {
      const state = getState();
      const usage = await getTodayUsage(state.salon?.id);
      res.json({
        salon: { name: state.salon?.name, slug: state.salon?.slug },
        automationEnabled: state.automationEnabled,
        soulVersion: state.config?.version,
        usage: {
          messages: usage.messages || 0,
          tokens: usage.tokens || 0,
          costEst: Number(usage.cost_est || 0).toFixed(4)
        },
        whatsapp: state.whatsappState
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/enable', (_req, res) => {
    setAutomation(true);
    res.json({ ok: true, automationEnabled: true });
  });

  app.post('/api/disable', (_req, res) => {
    setAutomation(false);
    res.json({ ok: true, automationEnabled: false });
  });

  app.post('/api/reload', async (_req, res) => {
    try {
      const result = await reloadConfig();
      res.json({ ok: true, version: result.config.version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/config/soul', (_req, res) => {
    const state = getState();
    res.json({ version: state.config?.version, soul_md: state.config?.soul_md || '' });
  });

  app.get('/api/config/faq', (_req, res) => {
    const state = getState();
    res.json({ version: state.config?.version, faq_json: state.config?.faq_json || [] });
  });

  app.get('/api/logs', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, LOG_BUFFER_SIZE);
    res.json(logBuffer.slice(-limit));
  });

  // ── Handover Queue API ──
  app.get('/api/handover-queue', async (_req, res) => {
    try {
      const state = getState();
      const queue = await getHandoverQueue(state.salon?.id);
      res.json(queue);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/handover/:id/claim', async (req, res) => {
    try {
      const data = await claimHandoverRequest(req.params.id);
      // Also set convo mode to human
      const state = getState();
      await setConvoMode(state.salon.id, data.customer_id, 'human');
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/handover/:id/resolve', async (req, res) => {
    try {
      const data = await resolveHandoverRequest(req.params.id);
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chats API ──
  app.get('/api/chats', async (_req, res) => {
    try {
      const state = getState();
      const chats = await getRecentChats(state.salon?.id);

      // Enrich with current mode
      const enriched = [];
      for (const chat of chats) {
        const mode = await getConvoMode(state.salon.id, chat.customerId);
        enriched.push({ ...chat, mode });
      }

      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/chats/:customerId/messages', async (req, res) => {
    try {
      const state = getState();
      const messages = await getCustomerMessages(state.salon?.id, req.params.customerId);
      const mode = await getConvoMode(state.salon.id, req.params.customerId);
      res.json({ messages, mode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/chats/:customerId/takeover', async (req, res) => {
    try {
      const state = getState();
      await setConvoMode(state.salon.id, req.params.customerId, 'human');
      res.json({ ok: true, mode: 'human' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/chats/:customerId/reply', async (req, res) => {
    try {
      const state = getState();
      const client = getWhatsAppClient();
      const { message } = req.body;
      const customerId = req.params.customerId;

      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'Message is required' });
      }
      if (!client) {
        return res.status(503).json({ error: 'WhatsApp client not ready' });
      }

      // Build correct WhatsApp ID — @lid IDs are already complete,
      // plain phone numbers need @c.us appended
      const waId = customerId.includes('@') ? customerId : customerId + '@c.us';
      console.log(`📤 Dashboard reply → waId=${waId}  customerId=${customerId}`);

      try {
        // Try getChatById first (works for both @c.us and @lid formats)
        const chat = await client.getChatById(waId);
        await chat.sendMessage(message.trim());
      } catch (chatErr) {
        console.log(`⚠️ getChatById failed for ${waId}, trying sendMessage directly:`, chatErr.message);
        await client.sendMessage(waId, message.trim());
      }

      // Log the human reply
      await logMessage({
        salonId: state.salon.id,
        customerId,
        direction: 'outbound',
        source: 'human',
        text: message.trim()
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('Reply send error:', err);
      res.status(500).json({ error: err.message || 'Failed to send message' });
    }
  });

  app.post('/api/chats/:customerId/resume', async (req, res) => {
    try {
      const state = getState();
      await setConvoMode(state.salon.id, req.params.customerId, 'bot');
      await resolveOpenRequestsForCustomer(state.salon.id, req.params.customerId);
      res.json({ ok: true, mode: 'bot' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // ── Whitelist API ──
  app.get('/api/whitelist', async (_req, res) => {
    try {
      const list = await getWhitelist();
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whitelist/add', async (req, res) => {
    try {
      const { number, label } = req.body;
      if (!number) return res.status(400).json({ error: 'Number is required' });
      const entry = await addToWhitelist({ number: String(number).trim(), label: label || '' });
      // Refresh runtime cache
      const list = await getWhitelist();
      setAdminWhitelist(list);
      res.json({ ok: true, entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whitelist/remove', async (req, res) => {
    try {
      const { number } = req.body;
      if (!number) return res.status(400).json({ error: 'Number is required' });
      await removeFromWhitelist(String(number).trim());
      const list = await getWhitelist();
      setAdminWhitelist(list);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Salon Switching API ──
  app.get('/api/salons', async (_req, res) => {
    try {
      const state = getState();
      const salons = await getAllSalons();
      setAllSalons(salons);
      res.json({ salons, activeSalonSlug: state.salon?.slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/salons/switch', async (req, res) => {
    try {
      const { slug } = req.body;
      if (!slug) return res.status(400).json({ error: 'slug is required' });
      const salon = await getSalonBySlug(slug);
      const config = await getActiveConfig(salon.id);
      setSalon(salon);
      setConfig(config);
      res.json({ ok: true, salon: { name: salon.name, slug: salon.slug }, version: config.version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Website Import / Config Draft API ──
  app.post('/api/import', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: 'URL is required' });
      const state = getState();
      const proposal = await proposeKnowledgeUpdate(url);
      await createDraftConfig({
        salonId: state.salon.id,
        soulMd: proposal.proposed.soul_md,
        faqJson: proposal.proposed.faq_json,
        createdBy: `import:${url}`
      });
      res.json({ ok: true, proposal });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/config/draft', async (_req, res) => {
    try {
      const state = getState();
      const draft = await getLatestDraftConfig(state.salon.id);
      res.json({ draft });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/config/approve', async (_req, res) => {
    try {
      const state = getState();
      const activated = await approveLatestDraft(state.salon.id);
      const config = await getActiveConfig(state.salon.id);
      setConfig(config);
      res.json({ ok: true, version: activated.version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/config/rollback/:version', async (req, res) => {
    try {
      const state = getState();
      const version = parseInt(req.params.version, 10);
      if (!version) return res.status(400).json({ error: 'Invalid version' });
      const restored = await rollbackToVersion(state.salon.id, version);
      const config = await getActiveConfig(state.salon.id);
      setConfig(config);
      res.json({ ok: true, version: restored.version });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard HTML ──
  app.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(dashboardHTML());
  });
}

// ─── Inline HTML ────────────────────────────────────────────
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Salon Bot Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-2: #232733;
    --border: #2e3345;
    --text: #e4e6ef;
    --text-dim: #8b8fa3;
    --accent: #6c5ce7;
    --accent-glow: rgba(108, 92, 231, 0.15);
    --green: #00d68f;
    --red: #ff6b6b;
    --orange: #ffa94d;
    --blue: #54a0ff;
    --radius: 12px;
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 0;
  }

  .header {
    background: linear-gradient(135deg, var(--surface) 0%, var(--surface-2) 100%);
    border-bottom: 1px solid var(--border);
    padding: 20px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .header h1 {
    font-size: 1.3rem;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent), #a29bfe);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .header .badge {
    font-size: 0.75rem;
    padding: 4px 12px;
    border-radius: 20px;
    font-weight: 600;
  }

  .badge-on { background: rgba(0, 214, 143, 0.15); color: var(--green); }
  .badge-off { background: rgba(255, 107, 107, 0.15); color: var(--red); }

  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
    margin-bottom: 20px;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px 24px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--accent); }

  .card-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--text-dim);
    margin-bottom: 14px;
    font-weight: 600;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid rgba(46, 51, 69, 0.5);
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--text-dim); font-size: 0.85rem; }
  .stat-value { font-weight: 600; font-size: 0.95rem; }

  .controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 10px 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-2);
    color: var(--text);
    font-family: inherit;
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn:hover { border-color: var(--accent); background: var(--accent-glow); }
  .btn:active { transform: scale(0.97); }
  .btn-green { border-color: var(--green); color: var(--green); }
  .btn-green:hover { background: rgba(0, 214, 143, 0.1); }
  .btn-red { border-color: var(--red); color: var(--red); }
  .btn-red:hover { background: rgba(255, 107, 107, 0.1); }
  .btn-blue { border-color: var(--blue); color: var(--blue); }
  .btn-blue:hover { background: rgba(84, 160, 255, 0.1); }
  .btn-orange { border-color: var(--orange); color: var(--orange); }
  .btn-orange:hover { background: rgba(255, 169, 77, 0.1); }
  .btn-sm { padding: 6px 14px; font-size: 0.75rem; }

  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 0;
    flex-wrap: wrap;
  }
  .tab {
    padding: 10px 20px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: var(--radius) var(--radius) 0 0;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
  }
  .tab.active { background: var(--surface); color: var(--accent); border-color: var(--accent); }
  .tab .tab-badge {
    position: absolute; top: 4px; right: 6px;
    background: var(--red); color: #fff; font-size: 0.6rem;
    padding: 1px 5px; border-radius: 8px; font-weight: 700;
    display: none;
  }
  .tab .tab-badge.show { display: inline; }

  .tab-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0 var(--radius) var(--radius) var(--radius);
    padding: 20px;
    min-height: 300px;
    display: none;
  }
  .tab-panel.active { display: block; }

  .config-text {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 400px;
    overflow-y: auto;
  }

  .log-container {
    max-height: 350px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    line-height: 1.8;
  }
  .log-line { padding: 2px 0; border-bottom: 1px solid rgba(46,51,69,0.3); }
  .log-time { color: var(--text-dim); margin-right: 8px; }
  .log-error { color: var(--red); }
  .log-warn { color: var(--orange); }

  .full-width { grid-column: 1 / -1; }

  /* ── Queue styles ── */
  .queue-item {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 18px;
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    transition: border-color 0.2s;
  }
  .queue-item:hover { border-color: var(--accent); }
  .queue-info { flex: 1; }
  .queue-customer { font-weight: 600; font-size: 0.9rem; }
  .queue-reason {
    font-size: 0.75rem; color: var(--orange);
    text-transform: uppercase; letter-spacing: 1px; margin-top: 2px;
  }
  .queue-message { font-size: 0.8rem; color: var(--text-dim); margin-top: 4px; }
  .queue-time { font-size: 0.7rem; color: var(--text-dim); }
  .queue-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .queue-status {
    font-size: 0.7rem; padding: 2px 8px;
    border-radius: 10px; font-weight: 600;
  }
  .status-requested { background: rgba(255,169,77,0.15); color: var(--orange); }
  .status-claimed { background: rgba(84,160,255,0.15); color: var(--blue); }

  .empty-state {
    text-align: center; color: var(--text-dim);
    padding: 40px; font-size: 0.9rem;
  }

  /* ── Chat styles ── */
  .chat-layout { display: grid; grid-template-columns: 280px 1fr; gap: 16px; min-height: 400px; }
  .chat-list { border-right: 1px solid var(--border); padding-right: 16px; overflow-y: auto; max-height: 500px; }
  .chat-list-item {
    padding: 10px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid transparent; margin-bottom: 6px; transition: all 0.2s;
  }
  .chat-list-item:hover { background: var(--surface-2); border-color: var(--border); }
  .chat-list-item.active { background: var(--accent-glow); border-color: var(--accent); }
  .chat-list-name { font-weight: 600; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
  .chat-list-preview { font-size: 0.75rem; color: var(--text-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-mode-badge {
    font-size: 0.6rem; padding: 1px 6px; border-radius: 8px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .mode-bot { background: rgba(0,214,143,0.15); color: var(--green); }
  .mode-human { background: rgba(84,160,255,0.15); color: var(--blue); }
  .mode-handover_requested { background: rgba(255,169,77,0.15); color: var(--orange); }

  .chat-thread { display: flex; flex-direction: column; }
  .chat-thread-header {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .chat-thread-title { font-weight: 600; font-size: 0.95rem; }
  .chat-messages {
    flex: 1; overflow-y: auto; max-height: 350px;
    padding: 8px 0; display: flex; flex-direction: column; gap: 6px;
  }
  .chat-msg {
    max-width: 80%; padding: 8px 14px; border-radius: 12px;
    font-size: 0.82rem; line-height: 1.5; position: relative;
  }
  .chat-msg-inbound { align-self: flex-start; background: var(--surface-2); border: 1px solid var(--border); }
  .chat-msg-outbound { align-self: flex-end; }
  .chat-msg-bot { background: rgba(108,92,231,0.15); border: 1px solid rgba(108,92,231,0.3); }
  .chat-msg-human { background: rgba(84,160,255,0.15); border: 1px solid rgba(84,160,255,0.3); }
  .chat-msg-system { align-self: center; background: rgba(255,169,77,0.1); border: 1px solid rgba(255,169,77,0.2); font-size: 0.75rem; color: var(--orange); }
  .chat-msg-time { font-size: 0.65rem; color: var(--text-dim); margin-top: 3px; }
  .chat-msg-source { font-size: 0.6rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }

  .chat-reply-box {
    display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);
  }
  .chat-reply-input {
    flex: 1; padding: 10px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); font-family: inherit; font-size: 0.85rem;
    outline: none; transition: border-color 0.2s;
  }
  .chat-reply-input:focus { border-color: var(--accent); }
  .chat-reply-input::placeholder { color: var(--text-dim); }

  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 500;
    z-index: 1000;
    animation: slideIn 0.3s ease;
    opacity: 0;
    transition: opacity 0.3s;
  }
  .toast.show { opacity: 1; }
  .toast-ok { background: rgba(0,214,143,0.15); color: var(--green); border: 1px solid var(--green); }
  .toast-err { background: rgba(255,107,107,0.15); color: var(--red); border: 1px solid var(--red); }

  @keyframes slideIn { from { transform: translateY(20px); } to { transform: translateY(0); } }
  @media (max-width: 900px) {
    .grid { grid-template-columns: 1fr; }
    .chat-layout { grid-template-columns: 1fr; }
    .chat-list { border-right: none; border-bottom: 1px solid var(--border); padding-right: 0; padding-bottom: 12px; max-height: 200px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>💈 Salon Bot Dashboard</h1>
  <div style="display:flex;align-items:center;gap:12px">
    <select id="salon-select" onchange="switchSalon(this.value)" style="background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:5px 10px;font-size:14px"></select>
    <span id="auto-badge" class="badge badge-on">AUTOMATION ON</span>
  </div>
</div>

<div class="container">
  <div class="grid">
    <!-- Status Card -->
    <div class="card">
      <div class="card-title">Status</div>
      <div class="stat-row"><span class="stat-label">Salon</span><span class="stat-value" id="s-salon">—</span></div>
      <div class="stat-row"><span class="stat-label">Slug</span><span class="stat-value" id="s-slug">—</span></div>
      <div class="stat-row"><span class="stat-label">SOUL version</span><span class="stat-value" id="s-version">—</span></div>
      <div class="stat-row"><span class="stat-label">WhatsApp</span><span class="stat-value" id="s-wa">—</span></div>
    </div>

    <!-- Usage Card -->
    <div class="card">
      <div class="card-title">Today's Usage</div>
      <div class="stat-row"><span class="stat-label">Messages</span><span class="stat-value" id="s-msgs">0</span></div>
      <div class="stat-row"><span class="stat-label">Tokens</span><span class="stat-value" id="s-tokens">0</span></div>
      <div class="stat-row"><span class="stat-label">Est. Cost</span><span class="stat-value" id="s-cost">$0.00</span></div>
    </div>

    <!-- Controls Card -->
    <div class="card full-width">
      <div class="card-title">Controls</div>
      <div class="controls">
        <button class="btn btn-green" onclick="apiPost('/api/enable')">✅ Enable</button>
        <button class="btn btn-red" onclick="apiPost('/api/disable')">⏸ Disable</button>
        <button class="btn" onclick="apiPost('/api/reload')">🔄 Reload Config</button>
      </div>
    </div>
  </div>

  <!-- Tabs -->
  <div class="tabs">
    <button class="tab active" onclick="switchTab('soul', this)">SOUL.md</button>
    <button class="tab" onclick="switchTab('faq', this)">FAQ</button>
    <button class="tab" onclick="switchTab('queue', this)">
      Queue <span id="queue-badge" class="tab-badge">0</span>
    </button>
    <button class="tab" onclick="switchTab('chats', this)">Chats</button>
    <button class="tab" onclick="switchTab('whitelist', this)">Whitelist</button>
    <button class="tab" onclick="switchTab('import', this)">Import</button>
    <button class="tab" onclick="switchTab('logs', this)">Logs</button>
  </div>

  <div id="panel-soul" class="tab-panel active"><div class="config-text" id="tab-soul">Loading...</div></div>
  <div id="panel-faq" class="tab-panel"><div class="config-text" id="tab-faq">Loading...</div></div>
  <div id="panel-queue" class="tab-panel"><div id="tab-queue">Loading...</div></div>
  <div id="panel-chats" class="tab-panel"><div id="tab-chats">Loading...</div></div>
  <div id="panel-whitelist" class="tab-panel"><div id="tab-whitelist">Loading...</div></div>
  <div id="panel-import" class="tab-panel"><div id="tab-import">Loading...</div></div>
  <div id="panel-logs" class="tab-panel"><div class="log-container" id="tab-logs">Loading...</div></div>
</div>

<div id="toast" class="toast"></div>

<script>
  // ── State ──
  let activeTab = 'soul';
  let selectedCustomer = null;

  // ── API helpers ──
  async function apiFetch(url) {
    const r = await fetch(url);
    return r.json();
  }

  async function apiPost(url, body) {
    try {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const r = await fetch(url, opts);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      showToast(d.ok ? 'Done!' : JSON.stringify(d), 'ok');
      refreshStatus();
      return d;
    } catch (e) {
      showToast(e.message, 'err');
    }
  }

  // ── Refresh functions ──
  async function refreshStatus() {
    try {
      const d = await apiFetch('/api/status');
      document.getElementById('s-salon').textContent = d.salon?.name || '—';
      document.getElementById('s-slug').textContent = d.salon?.slug || '—';
      document.getElementById('s-version').textContent = d.soulVersion ?? '—';
      document.getElementById('s-wa').textContent = d.whatsapp || '—';
      document.getElementById('s-msgs').textContent = d.usage?.messages ?? 0;
      document.getElementById('s-tokens').textContent = (d.usage?.tokens ?? 0).toLocaleString();
      document.getElementById('s-cost').textContent = '$' + (d.usage?.costEst || '0.0000');

      const badge = document.getElementById('auto-badge');
      badge.textContent = d.automationEnabled ? 'AUTOMATION ON' : 'AUTOMATION OFF';
      badge.className = 'badge ' + (d.automationEnabled ? 'badge-on' : 'badge-off');
    } catch {}
  }

  async function refreshSoul() {
    try {
      const d = await apiFetch('/api/config/soul');
      document.getElementById('tab-soul').textContent = d.soul_md || '(empty)';
    } catch {}
  }

  async function refreshFaq() {
    try {
      const d = await apiFetch('/api/config/faq');
      document.getElementById('tab-faq').textContent = JSON.stringify(d.faq_json, null, 2);
    } catch {}
  }

  async function refreshLogs() {
    try {
      const logs = await apiFetch('/api/logs?limit=100');
      const container = document.getElementById('tab-logs');
      container.innerHTML = logs.map(l => {
        const time = l.ts.slice(11, 19);
        const cls = l.level === 'error' ? 'log-error' : l.level === 'warn' ? 'log-warn' : '';
        return '<div class="log-line"><span class="log-time">' + time + '</span><span class="' + cls + '">' + escHtml(l.msg) + '</span></div>';
      }).join('');
      container.scrollTop = container.scrollHeight;
    } catch {}
  }

  // ── Queue ──
  async function refreshQueue() {
    try {
      const queue = await apiFetch('/api/handover-queue');
      const container = document.getElementById('tab-queue');
      const badge = document.getElementById('queue-badge');

      const openCount = queue.filter(q => q.status === 'requested').length;
      badge.textContent = openCount;
      badge.className = 'tab-badge' + (openCount > 0 ? ' show' : '');

      if (!queue.length) {
        container.innerHTML = '<div class="empty-state">🎉 No open handover requests</div>';
        return;
      }

      container.innerHTML = queue.map(q => {
        const time = new Date(q.created_at).toLocaleTimeString();
        const statusCls = q.status === 'requested' ? 'status-requested' : 'status-claimed';
        return '<div class="queue-item">' +
          '<div class="queue-info">' +
            '<div class="queue-customer">📱 ' + escHtml(q.customer_id) + '</div>' +
            '<div class="queue-reason">' + escHtml(q.reason) + '</div>' +
            (q.latest_message ? '<div class="queue-message">"' + escHtml(q.latest_message.slice(0, 100)) + '"</div>' : '') +
          '</div>' +
          '<div class="queue-time">' + time + '</div>' +
          '<span class="queue-status ' + statusCls + '">' + q.status + '</span>' +
          '<div class="queue-actions">' +
            (q.status === 'requested' ? '<button class="btn btn-blue btn-sm" onclick="claimRequest(\\'' + q.id + '\\')">Take Over</button>' : '') +
            '<button class="btn btn-sm" onclick="selectChat(\\'' + q.customer_id + '\\'); switchTab(\\'chats\\', document.querySelectorAll(\\'.tab\\')[3])">Open Chat</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } catch (err) {
      console.error('Queue refresh error:', err);
    }
  }

  async function claimRequest(id) {
    await apiPost('/api/handover/' + id + '/claim');
    refreshQueue();
  }

  // ── Chats ──
  async function refreshChats() {
    try {
      const chats = await apiFetch('/api/chats');
      const container = document.getElementById('tab-chats');

      if (!chats.length) {
        container.innerHTML = '<div class="empty-state">No conversations yet</div>';
        return;
      }

      const listHtml = chats.map(c => {
        const active = selectedCustomer === c.customerId ? ' active' : '';
        const modeCls = 'mode-' + c.mode;
        const time = new Date(c.lastAt).toLocaleTimeString();
        return '<div class="chat-list-item' + active + '" onclick="selectChat(\\'' + c.customerId + '\\')">' +
          '<div class="chat-list-name">' +
            '<span>' + escHtml(c.customerId) + '</span>' +
            '<span class="chat-mode-badge ' + modeCls + '">' + c.mode + '</span>' +
          '</div>' +
          '<div class="chat-list-preview">' + escHtml(c.lastMessage?.slice(0, 60) || '') + ' · ' + time + '</div>' +
        '</div>';
      }).join('');

      const threadHtml = selectedCustomer
        ? '<div class="chat-thread" id="chat-thread">Loading thread...</div>'
        : '<div class="empty-state">Select a chat to view messages</div>';

      container.innerHTML = '<div class="chat-layout"><div class="chat-list">' + listHtml + '</div><div>' + threadHtml + '</div></div>';

      if (selectedCustomer) loadThread(selectedCustomer);
    } catch (err) {
      console.error('Chats refresh error:', err);
    }
  }

  async function selectChat(customerId) {
    selectedCustomer = customerId;
    refreshChats();
  }

  async function loadThread(customerId) {
    try {
      const data = await apiFetch('/api/chats/' + customerId + '/messages');
      const threadEl = document.getElementById('chat-thread');
      if (!threadEl) return;

      // Preserve reply input value across refreshes
      const existingInput = document.getElementById('reply-input');
      const savedValue = existingInput ? existingInput.value : '';

      const modeCls = 'mode-' + data.mode;
      const isHuman = data.mode === 'human' || data.mode === 'handover_requested';

      let html = '<div class="chat-thread-header">' +
        '<div class="chat-thread-title">📱 ' + escHtml(customerId) + ' <span class="chat-mode-badge ' + modeCls + '">' + data.mode + '</span></div>' +
        '<div class="controls">' +
          (data.mode === 'bot' ? '<button class="btn btn-blue btn-sm" onclick="takeOverChat(\\'' + customerId + '\\')">Take Over</button>' : '') +
          (isHuman ? '<button class="btn btn-green btn-sm" onclick="resumeBot(\\'' + customerId + '\\')">Resume Bot</button>' : '') +
        '</div>' +
      '</div>';

      html += '<div class="chat-messages">';
      for (const m of data.messages) {
        const time = new Date(m.created_at).toLocaleTimeString();
        let cls = 'chat-msg ';
        if (m.source === 'system') cls += 'chat-msg-system';
        else if (m.direction === 'inbound') cls += 'chat-msg-inbound';
        else if (m.source === 'bot') cls += 'chat-msg-outbound chat-msg-bot';
        else if (m.source === 'human') cls += 'chat-msg-outbound chat-msg-human';
        else cls += 'chat-msg-outbound';

        html += '<div class="' + cls + '">';
        if (m.source !== 'system') html += '<div class="chat-msg-source">' + m.source + '</div>';
        html += escHtml(m.text);
        html += '<div class="chat-msg-time">' + time + '</div>';
        html += '</div>';
      }
      html += '</div>';

      // Reply box (only show if in human mode)
      if (isHuman) {
        html += '<div class="chat-reply-box">' +
          '<input class="chat-reply-input" id="reply-input" placeholder="Type a reply..." onkeydown="if(event.key===\\'Enter\\')sendReply(\\'' + customerId + '\\')">'+
          '<button class="btn btn-blue btn-sm" onclick="sendReply(\\'' + customerId + '\\')">Send</button>' +
        '</div>';
      }

      threadEl.innerHTML = html;

      // Restore reply input value
      const newInput = document.getElementById('reply-input');
      if (newInput && savedValue) {
        newInput.value = savedValue;
      }

      // Auto-scroll messages to bottom (smooth, after DOM paint)
      const msgsEl = threadEl.querySelector('.chat-messages');
      if (msgsEl) setTimeout(() => msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'smooth' }), 50);
    } catch (err) {
      console.error('Thread load error:', err);
    }
  }

  async function takeOverChat(customerId) {
    await apiPost('/api/chats/' + customerId + '/takeover');
    loadThread(customerId);
    refreshChats();
    refreshQueue();
  }

  async function resumeBot(customerId) {
    await apiPost('/api/chats/' + customerId + '/resume');
    loadThread(customerId);
    refreshChats();
    refreshQueue();
  }

  async function sendReply(customerId) {
    const input = document.getElementById('reply-input');
    const msg = input?.value?.trim();
    if (!msg) return;
    input.value = '';
    await apiPost('/api/chats/' + customerId + '/reply', { message: msg });
    loadThread(customerId);
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Tabs ──
  function switchTab(name, btn) {
    activeTab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');

    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel-' + name);
    if (panel) panel.classList.add('active');

    if (name === 'soul') refreshSoul();
    if (name === 'faq') refreshFaq();
    if (name === 'logs') refreshLogs();
    if (name === 'queue') refreshQueue();
    if (name === 'chats') refreshChats();
    if (name === 'whitelist') refreshWhitelist();
    if (name === 'import') refreshImport();
  }

  // ── Salon Selector ──
  async function loadSalonSelector() {
    try {
      const d = await apiFetch('/api/salons');
      const sel = document.getElementById('salon-select');
      if (!sel) return;
      sel.innerHTML = d.salons.map(s =>
        '<option value="' + s.slug + '"' + (s.slug === d.activeSalonSlug ? ' selected' : '') + '>' + escHtml(s.name) + '</option>'
      ).join('');
    } catch (e) { console.error('Salon selector error:', e); }
  }
  async function switchSalon(slug) {
    try {
      const d = await apiPost('/api/salons/switch', { slug });
      if (d && d.ok) { refreshStatus(); refreshSoul(); refreshFaq(); showToast('Switched to ' + slug, 'ok'); }
    } catch (e) { showToast('Switch failed: ' + e.message, 'err'); }
  }
  loadSalonSelector();

  // ── Whitelist Tab ──
  async function refreshWhitelist() {
    try {
      const list = await apiFetch('/api/whitelist');
      const el = document.getElementById('tab-whitelist');
      if (!el) return;
      let html = '<div style="margin-bottom:12px;display:flex;gap:8px">';
      html += '<input id="wl-number" placeholder="Phone number (digits only)" style="flex:1;padding:8px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0">';
      html += '<input id="wl-label" placeholder="Label (optional)" style="width:160px;padding:8px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0">';
      html += '<button class="btn btn-green btn-sm" onclick="addWhitelistEntry()">Add</button>';
      html += '</div>';
      html += '<table style="width:100%;border-collapse:collapse">';
      html += '<tr style="border-bottom:1px solid #334155"><th style="text-align:left;padding:6px">Number</th><th style="text-align:left;padding:6px">Label</th><th style="text-align:left;padding:6px">Status</th><th style="padding:6px">Action</th></tr>';
      for (const entry of list) {
        const statusCls = entry.is_active ? 'color:#4ade80' : 'color:#f87171';
        html += '<tr style="border-bottom:1px solid #1e293b">';
        html += '<td style="padding:6px">' + escHtml(entry.number) + '</td>';
        html += '<td style="padding:6px">' + escHtml(entry.label || '—') + '</td>';
        html += '<td style="padding:6px;' + statusCls + '">' + (entry.is_active ? 'Active' : 'Inactive') + '</td>';
        html += '<td style="padding:6px;text-align:center">';
        if (entry.is_active) html += '<button class="btn btn-red btn-sm" onclick="removeWhitelistEntry(\\'' + entry.number + '\\')">Remove</button>';
        html += '</td></tr>';
      }
      html += '</table>';
      el.innerHTML = html;
    } catch (e) { console.error('Whitelist load error:', e); }
  }
  window.addWhitelistEntry = async function() {
    const number = document.getElementById('wl-number')?.value?.trim();
    const label = document.getElementById('wl-label')?.value?.trim();
    if (!number) return showToast('Number is required', 'err');
    await apiPost('/api/whitelist/add', { number, label });
    refreshWhitelist();
  };
  window.removeWhitelistEntry = async function(number) {
    await apiPost('/api/whitelist/remove', { number });
    refreshWhitelist();
  };

  // ── Import Tab ──
  async function refreshImport() {
    try {
      const el = document.getElementById('tab-import');
      if (!el) return;
      const draftData = await apiFetch('/api/config/draft');
      let html = '<div style="margin-bottom:16px">';
      html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
      html += '<input id="import-url" placeholder="Enter salon website URL..." style="flex:1;padding:8px;background:#1e293b;border:1px solid #334155;border-radius:6px;color:#e2e8f0">';
      html += '<button class="btn btn-blue btn-sm" onclick="runImport()">🌐 Import</button>';
      html += '</div>';
      if (draftData.draft) {
        const d = draftData.draft;
        const faq = d.faq_json || [];
        html += '<div class="card" style="margin-top:8px">';
        html += '<div class="card-title">📝 Draft Config (created by: ' + escHtml(d.created_by || 'unknown') + ')</div>';
        html += '<div style="margin:8px 0"><strong>SOUL.md preview:</strong></div>';
        html += '<pre style="background:#0f172a;padding:10px;border-radius:6px;max-height:200px;overflow:auto;font-size:12px">' + escHtml((d.soul_md || '').slice(0, 1000)) + '</pre>';
        html += '<div style="margin:8px 0"><strong>FAQ entries: ' + faq.length + '</strong></div>';
        html += '<ul style="max-height:200px;overflow:auto;font-size:13px">';
        for (const f of faq.slice(0, 10)) {
          html += '<li style="margin:4px 0"><strong>Q:</strong> ' + escHtml(f.q) + '<br><strong>A:</strong> ' + escHtml(f.a) + '</li>';
        }
        if (faq.length > 10) html += '<li>... and ' + (faq.length - 10) + ' more</li>';
        html += '</ul>';
        html += '<div style="display:flex;gap:8px;margin-top:12px">';
        html += '<button class="btn btn-green btn-sm" onclick="approveDraft()">✅ Approve</button>';
        html += '<button class="btn btn-red btn-sm" onclick="rejectDraft()">❌ Reject</button>';
        html += '</div></div>';
      } else {
        html += '<div style="color:#94a3b8;padding:12px">No draft config pending. Use Import to generate one from a website URL.</div>';
      }
      html += '</div>';
      html += '<div id="import-status" style="margin-top:8px"></div>';
      el.innerHTML = html;
    } catch (e) { console.error('Import tab error:', e); }
  }
  window.runImport = async function() {
    const url = document.getElementById('import-url')?.value?.trim();
    if (!url) return showToast('URL is required', 'err');
    const statusEl = document.getElementById('import-status');
    if (statusEl) statusEl.innerHTML = '<div style="color:#60a5fa">⏳ Importing website... this may take a moment.</div>';
    try {
      await apiPost('/api/import', { url });
      refreshImport();
    } catch (e) {
      if (statusEl) statusEl.innerHTML = '<div style="color:#f87171">❌ Import failed: ' + escHtml(e.message) + '</div>';
    }
  };
  window.approveDraft = async function() {
    await apiPost('/api/config/approve');
    refreshImport();
    refreshSoul();
    refreshFaq();
  };
  window.rejectDraft = function() {
    showToast('Draft discarded (will be replaced on next import)', 'ok');
  };

  // ── Toast ──
  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast toast-' + type + ' show';
    setTimeout(() => el.classList.remove('show'), 2500);
  }

  // ── Init ──
  refreshStatus();
  refreshSoul();
  refreshQueue(); // initial queue count for badge
  setInterval(() => {
    refreshStatus();
    if (activeTab === 'logs') refreshLogs();
    if (activeTab === 'queue') refreshQueue();
    if (activeTab === 'chats' && selectedCustomer) {
      // Skip refresh if user is actively typing in reply box
      const replyInput = document.getElementById('reply-input');
      if (replyInput && document.activeElement === replyInput) return;
      loadThread(selectedCustomer);
    }
  }, 8000);
</script>
</body>
</html>`;
}
