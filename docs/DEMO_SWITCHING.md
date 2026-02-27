# Demo Switching Guide

How to switch between salon demos without redeploying.

## Quick Switch

1. **Update `.env`:**
   ```env
   ACTIVE_SALON_SLUG=new_salon_slug
   ```

2. **Restart the bot** (or use `/reload` if same salon):
   ```bash
   # Ctrl+C to stop, then:
   npm run dev
   ```

3. The bot will load the new salon's config from Supabase.

## Preparing a New Salon Demo

### 1. Create the salon in Supabase

```sql
INSERT INTO salons (name, slug, is_active)
VALUES ('New Salon Name', 'new_salon_slug', true);
```

### 2. Add a config

```sql
INSERT INTO salon_configs (salon_id, version, status, soul_md, faq_json, created_by)
VALUES (
  'the-new-salon-uuid',
  1,
  'active',
  'You are the WhatsApp assistant for New Salon Name. Answer questions about services, hours, and appointments.',
  '[{"q": "What are your hours?", "a": "We are open Mon-Sat 9am-7pm."}]',
  'manual'
);
```

### 3. Switch and restart

```env
ACTIVE_SALON_SLUG=new_salon_slug
```

```bash
npm run dev
```

## Using Website Import

Instead of manually writing FAQ/SOUL, let the bot extract knowledge from the salon's website:

```
/import https://new-salon-website.com
/approve
```

This creates a draft config from the website content, then activates it.

## Session Considerations

- Each salon slug gets its own WhatsApp session (stored in `.wwebjs_auth/session-<slug>`)
- Switching salons may require a new QR scan if the slug changes
- To force a fresh session: `rm -rf .wwebjs_auth/session-new_salon_slug`

## Verifying the Switch

After restarting, check:
- Terminal shows: `✅ Loaded salon: New Salon Name (new_salon_slug)`
- Send `/status` from owner number to confirm
- Dashboard at `http://localhost:3000` shows the new salon info
