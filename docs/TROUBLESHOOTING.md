# Troubleshooting Guide

## Chrome / Puppeteer Issues

**Error**: `Failed to launch the browser process`
- Ensure Chrome/Chromium is installed: `which google-chrome`
- Set `CHROME_PATH` in `.env` if needed

**Error**: `ProtocolError: Execution context was destroyed`
- Normal during WhatsApp page load — retry logic handles this automatically (3 attempts)

## WhatsApp Session

**QR code not scanning**: Try deleting `.wwebjs_auth/` and restarting.

**Disconnected frequently**: Check internet stability. Bot auto-detects disconnection but does not auto-reconnect (requires restart).

## LLM / API Errors

**Error**: `LLM request timed out`
- Check Groq API status. Default timeout is 20 seconds.

**Error**: `fetch failed` with non-ASCII messages
- Fixed: LLM now uses `axios` instead of native fetch. Ensure `axios` is in dependencies.

**`<think>` tags in responses**: Stripped automatically for reasoning models (DeepSeek, Qwen).

## Supabase

**Error**: `relation does not exist`
- Run all required migrations. Check tables: `salons`, `salon_configs`, `convo_state`, `usage_daily`, `messages`, `handover_requests`, `notifications_log`, `admin_whitelist`

## Dashboard

**Dashboard not loading**: Verify `PORT` in `.env` (default 3000). Check if port is in use.

**Chat thread missing messages**: Thread view shows the latest 100 messages. Older messages are not displayed.

**Reply not sending**: Check WhatsApp client state on dashboard. Verify the customer ID format (`@lid` IDs are handled automatically).

**Salon selector empty**: Ensure at least one salon exists in the `salons` table.

## Handover / Notifications

**Telegram alerts not sending**: Verify `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`. Alerts skip gracefully if not configured.

**Bot responds during human mode**: Check `convo_state` table — customer should be in `human` or `handover_requested` mode.

## Admin Commands Not Working

**"Unauthorized" reply**: Your number is not in the admin whitelist. Add it via Dashboard → Whitelist tab.

**Commands ignored**: Ensure message starts with `/` and your number is whitelisted and active.

## Multilingual

**Non-English causing handover**: The bot uses LLM-based intent detection for non-English. If the LLM fails, it falls back to handover. Check LLM connectivity.

**Greetings/thanks not caught**: English shortcuts are a fast-path. Non-English pleasantries go through the LLM (works but adds latency).
