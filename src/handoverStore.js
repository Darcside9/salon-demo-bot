import { supabase } from './salonStore.js';

/**
 * Create a handover request (or reuse an existing open one for the same customer).
 */
export async function createHandoverRequest({ salonId, customerId, reason, latestMessage }) {
    // Upsert: if there's already an open request for this customer, update it
    const { data: existing } = await supabase
        .from('handover_requests')
        .select('id')
        .eq('salon_id', salonId)
        .eq('customer_id', customerId)
        .in('status', ['requested', 'claimed'])
        .maybeSingle();

    if (existing) {
        // Update the existing open request with latest info
        const { data, error } = await supabase
            .from('handover_requests')
            .update({ reason, latest_message: latestMessage })
            .eq('id', existing.id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    const { data, error } = await supabase
        .from('handover_requests')
        .insert({
            salon_id: salonId,
            customer_id: customerId,
            reason,
            latest_message: latestMessage
        })
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Get the handover queue — open requests (requested + claimed).
 */
export async function getHandoverQueue(salonId) {
    const { data, error } = await supabase
        .from('handover_requests')
        .select('*')
        .eq('salon_id', salonId)
        .in('status', ['requested', 'claimed'])
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

/**
 * Claim a handover request (operator takes over).
 */
export async function claimHandoverRequest(requestId, assignedTo = 'operator') {
    const { data, error } = await supabase
        .from('handover_requests')
        .update({ status: 'claimed', assigned_to: assignedTo })
        .eq('id', requestId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Resolve a handover request.
 */
export async function resolveHandoverRequest(requestId) {
    const { data, error } = await supabase
        .from('handover_requests')
        .update({ status: 'resolved' })
        .eq('id', requestId)
        .select()
        .single();

    if (error) throw error;
    return data;
}

/**
 * Resolve all open requests for a customer (used on Resume Bot).
 */
export async function resolveOpenRequestsForCustomer(salonId, customerId) {
    const { error } = await supabase
        .from('handover_requests')
        .update({ status: 'resolved' })
        .eq('salon_id', salonId)
        .eq('customer_id', customerId)
        .in('status', ['requested', 'claimed']);

    if (error) console.error('resolveOpenRequestsForCustomer error:', error.message);
}
