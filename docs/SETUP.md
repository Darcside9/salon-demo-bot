# Setup Guide — Salon Demo Bot

## Prerequisites
- Node.js v20+
- Google Chrome / Chromium installed
- Supabase project with required tables
- Groq API key (or OpenAI-compatible provider)
- Telegram Bot (optional, for handover alerts)

## 1. Clone & Install

```bash
git clone <repo-url>
cd salon-demo-bot
npm install
```

## 2. Environment Variables

Copy the example and fill in your values:
```bash
cp .env.example .env
```

Edit `.env` with your actual credentials:

| Variable | Required | Description |
|----------|----------|-------------|
| `SUPABASE_URL` | ✅ | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (not anon key) |
| `LLM_API_KEY` | ✅ | Groq or OpenAI-compatible API key |
| `LLM_MODEL` | ✅ | Model name (e.g. `qwen/qwen3-32b`) |
| `LLM_BASE_URL` | ✅ | API endpoint URL |
| `OWNER_NUMBER` | ✅ | Initial admin number (digits only, seeded to whitelist) |
| `ACTIVE_SALON_SLUG` | ✅ | Default salon on boot (e.g. `demo_salon_1`) |
| `PORT` | ❌ | Server port (default: 3000) |
| `TELEGRAM_BOT_TOKEN` | ❌ | For handover alerts |
| `TELEGRAM_CHAT_ID` | ❌ | Your Telegram chat ID |

> **Security**: `.env` is gitignored. Never commit secrets. All secrets stay in `.env`, not in the database.

## 3. Supabase Tables

Required tables: `salons`, `salon_configs`, `convo_state`, `usage_daily`, `messages`, `handover_requests`, `notifications_log`, `admin_whitelist`

## 4. Architecture Overview

- **1 shared WhatsApp number** for the demo
- **2 salon profiles** (`demo_salon_1`, `demo_salon_2`) switchable from dashboard
- **Dashboard** is the primary admin interface (http://localhost:3000)
- **WhatsApp commands** limited to safe operational commands only
- **Admin whitelist** managed via dashboard (not hardcoded in env)
- **Website import** follows proposal → review → approve/reject flow

## 5. Start

```bash
npm run dev    # Development with auto-reload
npm start      # Production
```

1. Scan the QR code with the salon WhatsApp account
2. Open http://localhost:3000 for the dashboard
3. Switch between salon profiles using the dropdown in the header
