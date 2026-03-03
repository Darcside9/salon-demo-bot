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
import { relinkWhatsApp } from './whatsapp.js';
import qrcode from 'qrcode';

// ─── Dashboard setup ────────────────────────────────────────
export function setupDashboard({ app, reloadConfig }) {

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

  // ── WhatsApp & Logs API ──
  app.get('/api/whatsapp/status', (req, res) => {
    const state = getState();
    res.json({ status: state.whatsappStatus, updatedAt: state.qrUpdatedAt });
  });

  app.get('/api/whatsapp/qr', async (req, res) => {
    try {
      const state = getState();
      if (!state.qr) {
        return res.json({ qr: null, updatedAt: state.qrUpdatedAt });
      }
      const dataUrl = await qrcode.toDataURL(state.qr, { width: 300, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
      res.json({ qr: dataUrl, updatedAt: state.qrUpdatedAt });
    } catch (err) {
      res.status(500).json({ error: 'Failed to generate QR data URL' });
    }
  });

  let relinkMutex = false;
  let lastRelinkTime = 0;

  app.post('/api/whatsapp/relink', async (req, res) => {
    if (relinkMutex) {
      return res.status(429).json({ error: 'Relink is already in progress. Please wait.' });
    }
    const state = getState();
    if (state.whatsappState === 'INITIALIZING' || state.whatsappState === 'LOADING' || state.whatsappState === 'LINKING') {
      return res.status(409).json({ error: 'Client is currently booting up. Cannot destroy it right now.' });
    }

    const now = Date.now();
    if (now - lastRelinkTime < 30000) {
      return res.status(429).json({ error: 'Relink was requested recently. Cooldown is 30 seconds.' });
    }

    try {
      relinkMutex = true;
      lastRelinkTime = now;
      await relinkWhatsApp();
      res.json({ ok: true, message: 'Relink started' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    } finally {
      relinkMutex = false;
    }
  });

  app.get('/api/logs/tail', (req, res) => {
    const state = getState();
    const limit = parseInt(req.query.lines, 10) || 200;
    const lines = state.logBuffer.slice(-limit);
    res.json({ lines });
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

      // Build WhatsApp ID — try @lid first (modern linked devices), then @c.us
      const hasAt = customerId.includes('@');
      const lidId = hasAt ? customerId : customerId + '@lid';
      const cusId = hasAt ? customerId : customerId + '@c.us';

      console.log(`📤 Dashboard reply → customerId=${customerId}  trying lid=${lidId}`);

      let sent = false;

      // Attempt 1: getChatById with @lid
      try {
        const chat = await client.getChatById(lidId);
        await chat.sendMessage(message.trim());
        sent = true;
      } catch (e1) {
        console.log(`⚠️ getChatById @lid failed: ${e1.message}`);
      }

      // Attempt 2: sendMessage with @lid directly
      if (!sent) {
        try {
          await client.sendMessage(lidId, message.trim());
          sent = true;
        } catch (e2) {
          console.log(`⚠️ sendMessage @lid failed: ${e2.message}`);
        }
      }

      // Attempt 3: getChatById with @c.us
      if (!sent) {
        try {
          const chat = await client.getChatById(cusId);
          await chat.sendMessage(message.trim());
          sent = true;
        } catch (e3) {
          console.log(`⚠️ getChatById @c.us failed: ${e3.message}`);
        }
      }

      // Attempt 4: sendMessage with @c.us
      if (!sent) {
        await client.sendMessage(cusId, message.trim());
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

  // ── File Uploads API ──
  app.post('/api/upload/soul', express.text(), async (req, res) => {
    try {
      const state = getState();
      const currentConfig = await getActiveConfig(state.salon.id);

      const soul_md = req.body;
      if (!soul_md || typeof soul_md !== 'string') {
        return res.status(400).json({ error: 'Invalid SOUL content, must be raw text' });
      }

      await createDraftConfig({
        salonId: state.salon.id,
        soulMd: soul_md,
        faqJson: currentConfig?.faq_json || [],
        createdBy: 'admin_dashboard_upload'
      });
      const activated = await approveLatestDraft(state.salon.id);

      const newConfig = await getActiveConfig(state.salon.id);
      setConfig(newConfig);

      res.json({ ok: true, version: activated.version });
    } catch (err) {
      console.error('SOUL upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/upload/faq', express.json(), async (req, res) => {
    try {
      const state = getState();
      const currentConfig = await getActiveConfig(state.salon.id);

      const faq_json = req.body;
      if (!Array.isArray(faq_json)) {
        return res.status(400).json({ error: 'FAQ must be a JSON array' });
      }

      await createDraftConfig({
        salonId: state.salon.id,
        soulMd: currentConfig?.soul_md || '',
        faqJson: faq_json,
        createdBy: 'admin_dashboard_upload'
      });
      const activated = await approveLatestDraft(state.salon.id);

      const newConfig = await getActiveConfig(state.salon.id);
      setConfig(newConfig);

      res.json({ ok: true, version: activated.version });
    } catch (err) {
      console.error('FAQ upload error:', err);
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
    --bg: #0b0d12;
    --surface: #141720;
    --surface-2: #1c2030;
    --surface-3: #252a3a;
    --border: #2a2f42;
    --border-hover: #3d4463;
    --text: #e8eaf0;
    --text-dim: #7c819a;
    --accent: #7c6df0;
    --accent-light: #a29bfe;
    --accent-glow: rgba(124, 109, 240, 0.12);
    --accent-glow-strong: rgba(124, 109, 240, 0.25);
    --green: #34d399;
    --green-glow: rgba(52, 211, 153, 0.12);
    --red: #f87171;
    --red-glow: rgba(248, 113, 113, 0.12);
    --orange: #fbbf24;
    --orange-glow: rgba(251, 191, 36, 0.12);
    --blue: #60a5fa;
    --blue-glow: rgba(96, 165, 250, 0.12);
    --radius: 14px;
    --radius-sm: 10px;
    --ease: cubic-bezier(0.4, 0, 0.2, 1);
    --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 0;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Custom Scrollbars ── */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-hover); }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, rgba(20, 23, 32, 0.95) 0%, rgba(28, 32, 48, 0.95) 100%);
    backdrop-filter: blur(20px) saturate(1.5);
    -webkit-backdrop-filter: blur(20px) saturate(1.5);
    border-bottom: 1px solid var(--border);
    padding: 18px 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 100;
  }

  .header h1 {
    font-size: 1.25rem;
    font-weight: 700;
    background: linear-gradient(135deg, var(--accent) 0%, var(--accent-light) 50%, #ddd6fe 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.3px;
  }

  .header .badge {
    font-size: 0.7rem;
    padding: 5px 14px;
    border-radius: 20px;
    font-weight: 600;
    letter-spacing: 0.5px;
    transition: all 0.3s var(--ease);
  }

  .badge-on {
    background: var(--green-glow);
    color: var(--green);
    box-shadow: 0 0 12px rgba(52, 211, 153, 0.15);
  }
  .badge-off {
    background: var(--red-glow);
    color: var(--red);
    box-shadow: 0 0 12px rgba(248, 113, 113, 0.15);
  }

  /* ── Salon Dropdown ── */
  #salon-select {
    appearance: none;
    -webkit-appearance: none;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 8px 32px 8px 14px;
    font-family: inherit;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.25s var(--ease);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='7' viewBox='0 0 12 7'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%237c819a' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    outline: none;
  }
  #salon-select:hover { border-color: var(--accent); }
  #salon-select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  #salon-select option { background: var(--surface-2); color: var(--text); }

  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  /* ── Grid ── */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
    margin-bottom: 22px;
  }

  /* ── Cards ── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px 24px;
    transition: all 0.3s var(--ease);
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), var(--accent-light));
    opacity: 0;
    transition: opacity 0.3s var(--ease);
  }
  .card:hover {
    border-color: var(--border-hover);
    box-shadow: 0 4px 24px rgba(0,0,0,0.2), 0 0 0 1px rgba(124,109,240,0.06);
    transform: translateY(-1px);
  }
  .card:hover::before { opacity: 1; }

  .card-title {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 1.8px;
    color: var(--text-dim);
    margin-bottom: 14px;
    font-weight: 600;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 7px 0;
    border-bottom: 1px solid rgba(42, 47, 66, 0.4);
    transition: background 0.2s var(--ease);
  }
  .stat-row:last-child { border-bottom: none; }
  .stat-row:hover { background: rgba(124,109,240,0.04); border-radius: 6px; }
  .stat-label { color: var(--text-dim); font-size: 0.84rem; }
  .stat-value { font-weight: 600; font-size: 0.95rem; }

  /* ── Controls ── */
  .controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  /* ── Buttons ── */
  .btn {
    padding: 10px 22px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    font-family: inherit;
    font-size: 0.83rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.25s var(--ease);
    position: relative;
    overflow: hidden;
  }
  .btn::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, transparent 70%);
    opacity: 0;
    transition: opacity 0.3s var(--ease);
  }
  .btn:hover {
    border-color: var(--accent);
    background: var(--accent-glow);
    transform: translateY(-1px);
    box-shadow: 0 3px 12px rgba(0,0,0,0.2);
  }
  .btn:hover::after { opacity: 1; }
  .btn:active { transform: translateY(0) scale(0.97); box-shadow: none; }
  .btn-green {
    border-color: rgba(52,211,153,0.4);
    color: var(--green);
    background: var(--green-glow);
  }
  .btn-green:hover {
    background: rgba(52, 211, 153, 0.2);
    border-color: var(--green);
    box-shadow: 0 3px 12px rgba(52,211,153,0.15);
  }
  .btn-red {
    border-color: rgba(248,113,113,0.4);
    color: var(--red);
    background: var(--red-glow);
  }
  .btn-red:hover {
    background: rgba(248, 113, 113, 0.2);
    border-color: var(--red);
    box-shadow: 0 3px 12px rgba(248,113,113,0.15);
  }
  .btn-blue {
    border-color: rgba(96,165,250,0.4);
    color: var(--blue);
    background: var(--blue-glow);
  }
  .btn-blue:hover {
    background: rgba(96, 165, 250, 0.2);
    border-color: var(--blue);
    box-shadow: 0 3px 12px rgba(96,165,250,0.15);
  }
  .btn-orange {
    border-color: rgba(251,191,36,0.4);
    color: var(--orange);
    background: var(--orange-glow);
  }
  .btn-orange:hover {
    background: rgba(251, 191, 36, 0.2);
    border-color: var(--orange);
    box-shadow: 0 3px 12px rgba(251,191,36,0.15);
  }
  .btn-sm { padding: 6px 14px; font-size: 0.73rem; border-radius: 8px; }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    gap: 2px;
    margin-bottom: 0;
    flex-wrap: wrap;
  }
  .tab {
    padding: 11px 22px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom: none;
    border-radius: var(--radius) var(--radius) 0 0;
    font-family: inherit;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--text-dim);
    cursor: pointer;
    transition: all 0.25s var(--ease);
    position: relative;
  }
  .tab::after {
    content: '';
    position: absolute;
    bottom: 0; left: 50%; right: 50%;
    height: 2px;
    background: var(--accent);
    border-radius: 1px;
    transition: all 0.3s var(--ease-bounce);
  }
  .tab:hover {
    color: var(--text);
    background: var(--surface-3);
  }
  .tab.active {
    background: var(--surface);
    color: var(--accent-light);
    border-color: var(--border-hover);
  }
  .tab.active::after {
    left: 12px;
    right: 12px;
  }
  .tab .tab-badge {
    position: absolute; top: 4px; right: 6px;
    background: var(--red); color: #fff; font-size: 0.6rem;
    padding: 1px 5px; border-radius: 8px; font-weight: 700;
    display: none;
    animation: badgePop 0.3s var(--ease-bounce);
  }
  .tab .tab-badge.show { display: inline; }

  /* ── Tab Panels ── */
  .tab-panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 0 var(--radius) var(--radius) var(--radius);
    padding: 22px;
    min-height: 300px;
    display: none;
  }
  .tab-panel.active {
    display: block;
    animation: panelFadeIn 0.35s var(--ease);
  }

  .config-text {
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.8rem;
    line-height: 1.7;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 400px;
    overflow-y: auto;
    padding: 4px;
  }

  .log-container {
    max-height: 350px;
    overflow-y: auto;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 0.75rem;
    line-height: 1.8;
  }
  .log-line {
    padding: 3px 6px;
    border-bottom: 1px solid rgba(42,47,66,0.25);
    border-radius: 4px;
    transition: background 0.15s var(--ease);
  }
  .log-line:hover { background: rgba(124,109,240,0.04); }
  .log-time { color: var(--text-dim); margin-right: 8px; }
  .log-error { color: var(--red); }
  .log-warn { color: var(--orange); }

  .full-width { grid-column: 1 / -1; }

  /* ── Queue styles ── */
  .queue-item {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px 18px;
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    transition: all 0.25s var(--ease);
  }
  .queue-item:hover {
    border-color: var(--border-hover);
    transform: translateX(3px);
    box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  }
  .queue-info { flex: 1; }
  .queue-customer { font-weight: 600; font-size: 0.9rem; }
  .queue-reason {
    font-size: 0.73rem; color: var(--orange);
    text-transform: uppercase; letter-spacing: 1px; margin-top: 3px;
  }
  .queue-message { font-size: 0.8rem; color: var(--text-dim); margin-top: 4px; }
  .queue-time { font-size: 0.7rem; color: var(--text-dim); }
  .queue-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .queue-status {
    font-size: 0.7rem; padding: 3px 10px;
    border-radius: 12px; font-weight: 600;
  }
  .status-requested { background: var(--orange-glow); color: var(--orange); }
  .status-claimed { background: var(--blue-glow); color: var(--blue); }

  .empty-state {
    text-align: center; color: var(--text-dim);
    padding: 48px 24px; font-size: 0.9rem;
  }

  /* ── Chat styles ── */
  .chat-layout { display: grid; grid-template-columns: 280px 1fr; gap: 16px; min-height: 420px; }
  .chat-list {
    border-right: 1px solid var(--border);
    padding-right: 16px;
    overflow-y: auto;
    max-height: 520px;
  }
  .chat-list-item {
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    border: 1px solid transparent;
    margin-bottom: 6px;
    transition: all 0.2s var(--ease);
  }
  .chat-list-item:hover {
    background: var(--surface-2);
    border-color: var(--border);
    transform: translateX(2px);
  }
  .chat-list-item.active {
    background: var(--accent-glow);
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow);
  }
  .chat-list-name { font-weight: 600; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
  .chat-list-preview { font-size: 0.75rem; color: var(--text-dim); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chat-mode-badge {
    font-size: 0.6rem; padding: 2px 7px; border-radius: 8px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .mode-bot { background: var(--green-glow); color: var(--green); }
  .mode-human { background: var(--blue-glow); color: var(--blue); }
  .mode-handover_requested { background: var(--orange-glow); color: var(--orange); }

  .chat-thread { display: flex; flex-direction: column; }
  .chat-thread-header {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .chat-thread-title { font-weight: 600; font-size: 0.95rem; }
  .chat-messages {
    flex: 1; overflow-y: auto; max-height: 360px;
    padding: 8px 0; display: flex; flex-direction: column; gap: 8px;
  }
  .chat-msg {
    max-width: 78%;
    padding: 10px 16px;
    border-radius: 14px;
    font-size: 0.82rem;
    line-height: 1.55;
    position: relative;
    animation: msgSlideIn 0.25s var(--ease);
  }
  .chat-msg-inbound {
    align-self: flex-start;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-bottom-left-radius: 4px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.1);
  }
  .chat-msg-outbound { align-self: flex-end; border-bottom-right-radius: 4px; }
  .chat-msg-bot {
    background: rgba(124,109,240,0.12);
    border: 1px solid rgba(124,109,240,0.22);
    box-shadow: 0 1px 6px rgba(124,109,240,0.08);
  }
  .chat-msg-human {
    background: rgba(96,165,250,0.12);
    border: 1px solid rgba(96,165,250,0.22);
    box-shadow: 0 1px 6px rgba(96,165,250,0.08);
  }
  .chat-msg-system {
    align-self: center;
    background: rgba(251,191,36,0.08);
    border: 1px solid rgba(251,191,36,0.15);
    font-size: 0.75rem;
    color: var(--orange);
    border-radius: 20px;
    padding: 6px 16px;
  }
  .chat-msg-time { font-size: 0.65rem; color: var(--text-dim); margin-top: 4px; }
  .chat-msg-source { font-size: 0.6rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }

  .chat-reply-box {
    display: flex; gap: 8px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border);
  }
  .chat-reply-input {
    flex: 1; padding: 11px 16px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-2);
    color: var(--text); font-family: inherit; font-size: 0.85rem;
    outline: none; transition: all 0.25s var(--ease);
  }
  .chat-reply-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  .chat-reply-input::placeholder { color: var(--text-dim); }

  /* ── Toast ── */
  .toast {
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 12px 24px;
    border-radius: var(--radius-sm);
    font-size: 0.84rem;
    font-weight: 500;
    z-index: 1000;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    opacity: 0;
    transform: translateY(12px) scale(0.96);
    transition: all 0.35s var(--ease-bounce);
    pointer-events: none;
  }
  .toast.show {
    opacity: 1;
    transform: translateY(0) scale(1);
    pointer-events: auto;
  }
  .toast-ok {
    background: rgba(52,211,153,0.12);
    color: var(--green);
    border: 1px solid rgba(52,211,153,0.3);
    box-shadow: 0 4px 20px rgba(52,211,153,0.1);
  }
  .toast-err {
    background: rgba(248,113,113,0.12);
    color: var(--red);
    border: 1px solid rgba(248,113,113,0.3);
    box-shadow: 0 4px 20px rgba(248,113,113,0.1);
  }

  /* ── Animations ── */
  @keyframes panelFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes msgSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes badgePop {
    0% { transform: scale(0); }
    60% { transform: scale(1.2); }
    100% { transform: scale(1); }
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  .loading { animation: pulse 1.5s var(--ease) infinite; color: var(--text-dim); }

  /* ── Responsive ── */
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
    <select id="salon-select" onchange="switchSalon(this.value)"></select>
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
    <button class="tab" id="tab-btn-link" onclick="switchTab('link', this)">Link Device</button>
    <button class="tab" onclick="switchTab('logs', this)">Logs</button>
  </div>

  <div id="panel-soul" class="tab-panel active">
    <div style="margin-bottom:15px; display:flex; gap:10px; align-items:center;">
      <input type="file" id="upload-soul" accept=".md" style="font-size:0.8rem;">
      <button class="btn btn-blue btn-sm" onclick="uploadConfig('soul', document.getElementById('upload-soul'))">Upload Custom SOUL</button>
    </div>
    <div class="config-text" id="tab-soul"><span class="loading">Loading...</span></div>
  </div>
  
  <div id="panel-faq" class="tab-panel">
    <div style="margin-bottom:15px; display:flex; gap:10px; align-items:center;">
      <input type="file" id="upload-faq" accept=".json" style="font-size:0.8rem;">
      <button class="btn btn-blue btn-sm" onclick="uploadConfig('faq', document.getElementById('upload-faq'))">Upload Custom FAQ</button>
    </div>
    <div class="config-text" id="tab-faq"><span class="loading">Loading...</span></div>
  </div>
  
  <div id="panel-queue" class="tab-panel"><div id="tab-queue"><span class="loading">Loading...</span></div></div>
  <div id="panel-chats" class="tab-panel"><div id="tab-chats"><span class="loading">Loading...</span></div></div>
  <div id="panel-whitelist" class="tab-panel"><div id="tab-whitelist"><span class="loading">Loading...</span></div></div>
  <div id="panel-import" class="tab-panel"><div id="tab-import"><span class="loading">Loading...</span></div></div>
  <div id="panel-link" class="tab-panel"><div id="tab-link"><span class="loading">Loading...</span></div></div>
  <div id="panel-logs" class="tab-panel"><div class="log-container" id="tab-logs"><span class="loading">Loading...</span></div></div>
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

  // ── Upload Handlers ──
  async function uploadConfig(type, inputEl) {
    const file = inputEl.files[0];
    if (!file) {
      showToast('Please select a file first', 'err');
      return;
    }
    
    try {
      inputEl.disabled = true;
      const text = await file.text();
      
      const endpoint = type === 'soul' ? '/api/upload/soul' : '/api/upload/faq';
      const contentType = type === 'soul' ? 'text/plain' : 'application/json';
      
      if (type === 'faq') {
        try { JSON.parse(text); } catch(e) { throw new Error('Invalid JSON format'); }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: text
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      
      showToast('Successfully uploaded ' + type.toUpperCase() + ' (v' + data.version + ')', 'ok');
      inputEl.value = '';
      
      if (type === 'soul') refreshSoul();
      if (type === 'faq') refreshFaq();
      refreshStatus();
    } catch (err) {
      showToast('Upload error: ' + err.message, 'err');
    } finally {
      inputEl.disabled = false;
    }
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

      let chatLayout = container.querySelector('.chat-layout');
      if (!chatLayout) {
        container.innerHTML = '<div class="chat-layout"><div class="chat-list"></div><div id="thread-wrapper" data-customer="' + (selectedCustomer || '') + '"><div class="empty-state">Select a chat to view messages</div></div></div>';
      }
      
      const chatList = container.querySelector('.chat-list');
      const existingNodes = Array.from(chatList.children);
      const newIds = new Set(chats.map(c => c.customerId));
      
      existingNodes.forEach(n => {
        if (!newIds.has(n.dataset.customerId)) n.remove();
      });

      chats.forEach((c, idx) => {
        let node = Array.from(chatList.children).find(el => el.dataset.customerId === c.customerId);
        const active = selectedCustomer === c.customerId ? ' active' : '';
        const modeCls = 'mode-' + c.mode;
        const time = new Date(c.lastAt).toLocaleTimeString();
        const previewText = escHtml(c.lastMessage?.slice(0, 60) || '') + ' · ' + time;
        
        if (!node) {
          node = document.createElement('div');
          node.dataset.customerId = c.customerId;
          node.onclick = () => selectChat(c.customerId);
          node.innerHTML = '<div class="chat-list-name"><span>' + escHtml(c.customerId) + '</span><span class="chat-mode-badge ' + modeCls + '">' + c.mode + '</span></div><div class="chat-list-preview">' + previewText + '</div>';
          chatList.appendChild(node);
        } else {
          const badge = node.querySelector('.chat-mode-badge');
          if (badge && badge.textContent !== c.mode) {
            badge.className = 'chat-mode-badge ' + modeCls;
            badge.textContent = c.mode;
          }
          const prevDiv = node.querySelector('.chat-list-preview');
          if (prevDiv && prevDiv.innerHTML !== previewText) {
            prevDiv.innerHTML = previewText;
          }
        }
        node.className = 'chat-list-item' + active;

        if (chatList.children[idx] !== node) {
          chatList.insertBefore(node, chatList.children[idx]);
        }
      });

      if (selectedCustomer) loadThread(selectedCustomer);
    } catch (err) {
      console.error('Chats refresh error:', err);
    }
  }

  async function selectChat(customerId) {
    selectedCustomer = customerId;
    const wrapper = document.getElementById('thread-wrapper');
    if (wrapper) {
      wrapper.innerHTML = '<div class="chat-thread" id="chat-thread">Loading thread...</div>';
      wrapper.dataset.customer = customerId;
    }
    refreshChats();
  }

  async function loadThread(customerId) {
    try {
      const data = await apiFetch('/api/chats/' + customerId + '/messages');
      const wrapper = document.getElementById('thread-wrapper');
      if (wrapper && wrapper.dataset.customer !== customerId) return; // Stale fetch

      let threadEl = document.getElementById('chat-thread');
      let msgsEl = threadEl ? threadEl.querySelector('.chat-messages') : null;
      
      if (!threadEl || !msgsEl) {
        if (wrapper) wrapper.innerHTML = '<div class="chat-thread" id="chat-thread"><div class="chat-thread-header"></div><div class="chat-messages"></div></div>';
        threadEl = document.getElementById('chat-thread');
        if (threadEl) msgsEl = threadEl.querySelector('.chat-messages');
      }

      const modeCls = 'mode-' + data.mode;
      const isHuman = data.mode === 'human' || data.mode === 'handover_requested';

      // 1. Header DOM Diff
      const headerEl = threadEl.querySelector('.chat-thread-header');
      const headerInner = '<div class="chat-thread-title">📱 ' + escHtml(customerId) + ' <span class="chat-mode-badge ' + modeCls + '">' + data.mode + '</span></div>' +
        '<div class="controls">' +
          (data.mode === 'bot' ? '<button class="btn btn-blue btn-sm" onclick="takeOverChat(\\'' + customerId + '\\')">Take Over</button>' : '') +
          (isHuman ? '<button class="btn btn-green btn-sm" onclick="resumeBot(\\'' + customerId + '\\')">Resume Bot</button>' : '') +
        '</div>';
      if (headerEl && headerEl.innerHTML !== headerInner) {
        headerEl.innerHTML = headerInner;
      }

      // 2. Messages DOM Diff
      const isAtBottom = msgsEl ? (msgsEl.scrollHeight - msgsEl.scrollTop <= msgsEl.clientHeight + 50) : true;

      data.messages.forEach((m, idx) => {
        let node = msgsEl.children[idx];
        const time = new Date(m.created_at).toLocaleTimeString();
        let cls = 'chat-msg ';
        if (m.source === 'system') cls += 'chat-msg-system';
        else if (m.direction === 'inbound') cls += 'chat-msg-inbound';
        else if (m.source === 'bot') cls += 'chat-msg-outbound chat-msg-bot';
        else if (m.source === 'human') cls += 'chat-msg-outbound chat-msg-human';
        else cls += 'chat-msg-outbound';

        let inner = '';
        if (m.source !== 'system') inner += '<div class="chat-msg-source">' + m.source + '</div>';
        inner += escHtml(m.text);
        inner += '<div class="chat-msg-time">' + time + '</div>';

        if (!node) {
          node = document.createElement('div');
          node.className = cls;
          node.dataset.id = String(m.id || idx);
          node.innerHTML = inner;
          msgsEl.appendChild(node);
        } else if (node.dataset.id !== String(m.id || idx) || node.innerHTML !== inner) {
          node.className = cls;
          node.dataset.id = String(m.id || idx);
          node.innerHTML = inner;
        }
      });

      // Cleanup trailing messages if deleted
      while (msgsEl.children.length > data.messages.length) {
        msgsEl.removeChild(msgsEl.lastChild);
      }

      // 3. Reply Box DOM Diff 
      let replyBox = threadEl.querySelector('.chat-reply-box');
      if (isHuman && !replyBox) {
        replyBox = document.createElement('div');
        replyBox.className = 'chat-reply-box';
        replyBox.innerHTML = '<input class="chat-reply-input" id="reply-input" placeholder="Type a reply..." onkeydown="if(event.key===\\'Enter\\')sendReply(\\'' + customerId + '\\')">' +
          '<button class="btn btn-blue btn-sm" onclick="sendReply(\\'' + customerId + '\\')">Send</button>';
        threadEl.appendChild(replyBox);
      } else if (!isHuman && replyBox) {
        replyBox.remove();
      }

      if (isAtBottom) {
        msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'smooth' });
      }
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
    if (name === 'link') refreshLink();
  }

  // ── WA Link Tab ──
  async function refreshLink() {
    try {
      const [statusRes, qrRes] = await Promise.all([
        apiFetch('/api/whatsapp/status'),
        apiFetch('/api/whatsapp/qr')
      ]);
      
      let html = '<div style="max-width:400px; margin:0 auto; text-align:center; padding-top:20px;">';
      html += '<h2 style="margin-bottom:10px;">WhatsApp Connection</h2>';
      
      const statusMap = {
        'READY': '<span style="color:#10b981;font-weight:600;">✅ Connected & Ready</span>',
        'NEEDS_LINK': '<span style="color:#eab308;font-weight:600;">⚠️ Needs Linking (Scan QR)</span>',
        'DISCONNECTED': '<span style="color:#ef4444;font-weight:600;">❌ Disconnected</span>',
        'LINKING': '<span style="color:#3b82f6;font-weight:600;">🔄 Relinking... Please wait</span>'
      };
      
      html += '<div style="font-size:18px; margin-bottom: 20px;">Status: ' + (statusMap[statusRes.status] || statusRes.status) + '</div>';
      
      if (statusRes.status === 'NEEDS_LINK' && qrRes.qr) {
        html += '<p style="color:#94a3b8;margin-bottom:15px;font-size:14px;">Scan this QR code with your business WhatsApp. It will refresh automatically.</p>';
        html += '<img src="' + qrRes.qr + '" alt="WhatsApp QR Code" style="border: 10px solid white; border-radius: 8px; margin-bottom:20px; width: 250px; height: 250px;">';
      } else if (statusRes.status === 'READY') {
        html += '<p style="color:#94a3b8;margin-bottom:20px;">Your bot is connected to WhatsApp and actively listening.</p>';
      }
      
      html += '<div style="margin-top: 30px;">';
      html += '<p style="font-size:12px;color:#64748b;margin-bottom:10px;">If the bot is unresponsive or you need to switch accounts, click below to force a relink.</p>';
      html += '<button class="btn btn-red" onclick="relinkDevice()">🔄 Force Re-Link Device</button>';
      html += '</div></div>';
      
      const container = document.getElementById('tab-link');
      if (container) container.innerHTML = html;
    } catch (err) {
      console.error('Link load error:', err);
    }
  }

  window.relinkDevice = async function() {
    if (!confirm('This will wipe the current WhatsApp session and force a new QR code to be generated. Proceed?')) return;
    try {
      const el = document.getElementById('tab-link');
      if (el) el.innerHTML = '<div style="text-align:center;padding:40px;"><span class="loading">Initiating Relink...</span></div>';
      await apiPost('/api/whatsapp/relink');
      showToast('Relink initiated. Wait for new QR code.', 'ok');
    } catch (err) {
      showToast('Error: ' + err.message, 'err');
    }
  };

  // ── Logs Tab ──
  async function refreshLogs() {
    try {
      const data = await apiFetch('/api/logs/tail?lines=200');
      const el = document.getElementById('tab-logs');
      if (!el) return;
      
      if (!data.lines || data.lines.length === 0) {
        el.innerHTML = '<div style="padding:20px;color:#94a3b8;">No logs available.</div>';
        return;
      }
      
      const logsHtml = data.lines.map(log => {
        let cls = '';
        if (log.level === 'error') cls = 'color:#ef4444;';
        else if (log.level === 'warn') cls = 'color:#eab308;';
        
        let time = new Date(log.ts).toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
        return '<div style="margin-bottom:4px;' + cls + '"><span style="color:#64748b;margin-right:10px;">[' + time + ']</span>' + escHtml(log.text) + '</div>';
      }).join('');
      
      const wasAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 10;
      el.innerHTML = logsHtml;
      
      if (wasAtBottom) {
        el.scrollTop = el.scrollHeight;
      }
    } catch (e) { console.error('Logs load error:', e); }
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
    if (activeTab === 'link') refreshLink();
    if (activeTab === 'queue') refreshQueue();
    if (activeTab === 'chats' && selectedCustomer) {
      // Skip refresh if user is actively typing in reply box
      const replyInput = document.getElementById('reply-input');
      if (replyInput && document.activeElement === replyInput) return;
      loadThread(selectedCustomer);
    }
  }, 2000);
</script>
</body>
</html>`;
}
