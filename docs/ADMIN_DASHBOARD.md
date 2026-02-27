# Admin Dashboard Guide

## Access
Open **http://localhost:3000** after starting the bot.

## Header
- **Salon Selector** — Dropdown to switch between salon profiles (e.g. Demo Salon 1 ↔ Demo Salon 2). Switching loads the selected salon's SOUL, FAQ, and config instantly.
- **Automation Badge** — Shows current automation status (ON/OFF)

## Status Cards
- **Status** — Active salon name, slug, SOUL version, WhatsApp connection state
- **Today's Usage** — Messages sent, tokens used, estimated cost
- **Controls** — Enable/Disable automation, Reload Config

## Tabs

### SOUL.md
Preview of the active SOUL behavior prompt for the current salon.

### FAQ
Preview of the active FAQ entries (JSON) for the current salon.

### Queue
Handover requests waiting for attention. Each item shows:
- Customer ID, reason, latest message, time
- **Take Over** — Claims the request and sets chat to human mode
- **Open Chat** — Jumps to the Chats tab for that customer

### Chats
Split-pane view:
- **Left**: Recent customer chats with mode badges (BOT / HUMAN / HANDOVER_REQUESTED)
- **Right**: Full message thread for selected customer
- **Reply box** (in human mode): Type and send replies via WhatsApp
- **Take Over / Resume Bot** buttons per chat

### Whitelist
Admin number management:
- **Add** — Enter phone number + optional label → adds to admin whitelist
- **Remove** — Deactivates a number from the whitelist
- Only whitelisted numbers can use admin chat commands on WhatsApp
- Changes take effect immediately (runtime cache refreshed)

### Import
Website import workflow:
1. Enter a public salon website URL → click **Import**
2. AI extracts content and generates proposed FAQ + SOUL updates
3. **Draft preview** shows proposed changes
4. **Approve** — Activates the draft as the new config
5. **Reject** — Discards the draft
6. If approved by mistake, use rollback via WhatsApp command `/rollback <version>`

### Logs
Recent console output from the bot (last 200 entries).

## Sensitive Config Policy
The following actions are **dashboard-only** and cannot be done via WhatsApp commands:
- Edit SOUL.md / FAQ directly
- Manage admin whitelist
- Change trigger rules or model settings
- Switch salon profiles
- Approve/reject website import proposals

## Safe WhatsApp Commands
These commands work from whitelisted admin numbers:
- `/help`, `/status`, `/enable`, `/disable`
- `/takeover`, `/resume`, `/reload`
- `/import <url>`, `/approve`, `/rollback <version>`
