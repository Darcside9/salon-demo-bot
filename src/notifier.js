import { supabase } from './salonStore.js';

/**
 * Send a Telegram alert for handover events.
 * Gracefully no-ops if credentials are not configured.
 */
export async function sendTelegramAlert({ salonId, customerId, reason, message }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
        console.warn('⚠️ Telegram not configured — skipping alert');
        return;
    }

    const text = [
        '🔔 Handover Request',
        '',
        '📱 Customer: ' + customerId,
        '📋 Reason: ' + reason,
        message ? '💬 Last message: ' + message.slice(0, 200) : '',
        '',
        '👉 Open the dashboard to respond.'
    ].filter(Boolean).join('\n');

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text
            })
        });

        const result = await res.json();

        if (!result.ok) {
            throw new Error(result.description || 'Telegram API error');
        }

        // Log success
        await logNotification({ salonId, customerId, eventType: 'handover_requested', status: 'sent', payload: { reason } });
        console.log('✅ Telegram alert sent');
    } catch (err) {
        console.error('❌ Telegram alert failed:', err.message);
        // Log failure
        await logNotification({ salonId, customerId, eventType: 'handover_requested', status: 'failed', error: err.message });
    }
}

/**
 * Log notification event to notifications_log.
 */
async function logNotification({ salonId, customerId, eventType, status, payload, error }) {
    try {
        await supabase
            .from('notifications_log')
            .insert({
                salon_id: salonId || null,
                customer_id: customerId || null,
                channel: 'telegram',
                event_type: eventType,
                status,
                payload: payload || null,
                error: error || null
            });
    } catch (logErr) {
        console.error('logNotification error:', logErr.message);
    }
}
