# Test Scenarios — Salon Demo Bot

## 1. WhatsApp Session
| Step | Action | Expected Result |
|------|--------|-----------------|
| 1a | Run `npm run dev` | QR code appears in terminal |
| 1b | Scan QR with salon WhatsApp | Console: `✅ WhatsApp authenticated` → `✅ WhatsApp client ready` |
| 1c | Send "Hi" from any number | Bot replies with greeting |

## 2. Basic Bot Behavior
| Step | Action | Expected Result |
|------|--------|-----------------|
| 2a | Send "Hi" | Greeting reply (no LLM call) |
| 2b | Send "What are your opening hours?" | FAQ match reply |
| 2c | Send "Do you do braids for kids?" | LLM fallback reply |
| 2d | Send "Thanks" | Short polite reply (no LLM call) |

## 3. Handover Workflow
| Step | Action | Expected Result |
|------|--------|-----------------|
| 3a | Send "I want to book tomorrow 4pm" | Bot sends waiting message, handover request created |
| 3b | Check dashboard Queue tab | Request visible with customer ID and reason |
| 3c | Click "Take Over" in dashboard | Mode changes to `human` |
| 3d | Type reply in dashboard + Send | Customer receives the human reply |
| 3e | Customer sends another message | Bot stays silent (human mode active) |
| 3f | Click "Resume Bot" in dashboard | Mode changes back to `bot` |
| 3g | Customer asks FAQ question | Bot replies normally |

## 4. Explicit Human Request
| Step | Action | Expected Result |
|------|--------|-----------------|
| 4a | Send "Can I speak to staff?" | Immediate handover + waiting message |
| 4b | Check dashboard Queue tab | Request visible with reason: explicit request |

## 5. Multilingual (No Auto-Handover)
| Step | Action | Expected Result |
|------|--------|-----------------|
| 5a | Send "你们的营业时间是什么？" (Chinese) | FAQ or LLM reply (NOT handover) |
| 5b | Send "ما هي ساعات العمل؟" (Arabic) | FAQ or LLM reply (NOT handover) |
| 5c | Send "Quels sont vos horaires ?" (French) | FAQ or LLM reply (NOT handover) |
| 5d | Send "¿Cuáles son sus horarios?" (Spanish) | FAQ or LLM reply (NOT handover) |

## 6. Website Import
| Step | Action | Expected Result |
|------|--------|-----------------|
| 6a | Dashboard Import tab → enter URL → Import | Draft proposal created |
| 6b | Preview draft in Import tab | SOUL.md preview + FAQ entries shown |
| 6c | Click Approve | Draft becomes active config |
| 6d | Ask question from imported content | Bot uses new data |
| 6e | `/rollback 1` via WhatsApp | Previous config restored |

## 7. Multi-Salon Switching
| Step | Action | Expected Result |
|------|--------|-----------------|
| 7a | Dashboard → salon dropdown → select Demo Salon 2 | Status card updates to Demo Salon 2 |
| 7b | Check SOUL.md tab | Shows Demo Salon 2's SOUL content |
| 7c | Customer sends FAQ question | Bot replies with Demo Salon 2's FAQ |
| 7d | Switch back to Demo Salon 1 | Config reverts, messaging loop intact |

## 8. Admin Commands (WhatsApp)
| Step | Action | Expected Result |
|------|--------|-----------------|
| 8a | Whitelisted number sends `/status` | Status reply with salon info |
| 8b | Whitelisted number sends `/help` | Help text with available commands |
| 8c | Non-whitelisted number sends `/status` | Treated as customer message (no admin response) |

## 9. Dashboard Whitelist Management
| Step | Action | Expected Result |
|------|--------|-----------------|
| 9a | Whitelist tab → enter number → Add | Number appears in list, runtime cache updated |
| 9b | Click Remove on a number | Number deactivated |
