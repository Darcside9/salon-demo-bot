import { supabase } from './salonStore.js';

/**
 * Log a message (inbound or outbound) to the messages table.
 */
export async function logMessage({ salonId, customerId, waMessageId, direction, source, text, meta }) {
    const { error } = await supabase
        .from('messages')
        .insert({
            salon_id: salonId,
            customer_id: customerId,
            wa_message_id: waMessageId || null,
            direction,
            source,
            text,
            meta: meta || null
        });

    if (error) console.error('logMessage error:', error.message);
}

/**
 * Get message thread for a specific customer (dashboard thread view).
 */
export async function getCustomerMessages(salonId, customerId, limit = 100) {
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('salon_id', salonId)
        .eq('customer_id', customerId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) throw error;
    // Reverse so newest messages appear at the bottom (chronological order)
    return (data || []).reverse();
}

/**
 * Get recent chats — distinct customers with their latest message.
 */
export async function getRecentChats(salonId, limit = 30) {
    // Use a raw RPC or distinct-on workaround via ordering
    // Supabase JS doesn't support DISTINCT ON, so we fetch recent messages and dedupe
    const { data, error } = await supabase
        .from('messages')
        .select('customer_id, text, source, direction, created_at')
        .eq('salon_id', salonId)
        .neq('customer_id', 'status@broadcast')
        .order('created_at', { ascending: false })
        .limit(200);

    if (error) throw error;

    const seen = new Map();
    for (const row of (data || [])) {
        if (!seen.has(row.customer_id)) {
            seen.set(row.customer_id, {
                customerId: row.customer_id,
                lastMessage: row.text,
                lastSource: row.source,
                lastDirection: row.direction,
                lastAt: row.created_at
            });
        }
    }

    return Array.from(seen.values()).slice(0, limit);
}
