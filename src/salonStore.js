import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export { supabase };

export async function getSalonBySlug(slug) {
  const { data, error } = await supabase
    .from('salons')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) throw error;
  return data;
}

export async function getActiveConfig(salonId) {
  const { data, error } = await supabase
    .from('salon_configs')
    .select('*')
    .eq('salon_id', salonId)
    .eq('status', 'active')
    .single();

  if (error) throw error;
  return data;
}

export async function getLatestDraftConfig(salonId) {
  const { data, error } = await supabase
    .from('salon_configs')
    .select('*')
    .eq('salon_id', salonId)
    .eq('status', 'draft')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function createDraftConfig({ salonId, soulMd, faqJson, createdBy }) {
  const { data, error } = await supabase
    .from('salon_configs')
    .insert({
      salon_id: salonId,
      soul_md: soulMd,
      faq_json: faqJson,
      status: 'draft',
      created_by: createdBy
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function approveLatestDraft(salonId) {
  const draft = await getLatestDraftConfig(salonId);
  if (!draft) throw new Error('No draft config found to approve.');

  const { error: archiveErr } = await supabase
    .from('salon_configs')
    .update({ status: 'archived' })
    .eq('salon_id', salonId)
    .eq('status', 'active');
  if (archiveErr) throw archiveErr;

  const { data, error } = await supabase
    .from('salon_configs')
    .update({ status: 'active' })
    .eq('id', draft.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function rollbackToVersion(salonId, version) {
  const { error: archiveErr } = await supabase
    .from('salon_configs')
    .update({ status: 'archived' })
    .eq('salon_id', salonId)
    .eq('status', 'active');
  if (archiveErr) throw archiveErr;

  const { data, error } = await supabase
    .from('salon_configs')
    .update({ status: 'active' })
    .eq('salon_id', salonId)
    .eq('version', version)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getConvoMode(salonId, customerId) {
  const { data, error } = await supabase
    .from('convo_state')
    .select('*')
    .eq('salon_id', salonId)
    .eq('customer_id', customerId)
    .maybeSingle();

  if (error) throw error;
  return data?.mode || 'bot';
}

export async function setConvoMode(salonId, customerId, mode) {
  const { data, error } = await supabase
    .from('convo_state')
    .upsert(
      {
        salon_id: salonId,
        customer_id: customerId,
        mode,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'salon_id,customer_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function incrementDailyUsage({ salonId, tokens = 0, costEst = 0 }) {
  const day = new Date().toISOString().slice(0, 10);

  const { data: existing, error: findErr } = await supabase
    .from('usage_daily')
    .select('*')
    .eq('salon_id', salonId)
    .eq('day', day)
    .maybeSingle();

  if (findErr) throw findErr;

  if (!existing) {
    const { data, error } = await supabase
      .from('usage_daily')
      .insert({
        salon_id: salonId,
        day,
        messages: 1,
        tokens,
        cost_est: costEst,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('usage_daily')
    .update({
      messages: (existing.messages || 0) + 1,
      tokens: (existing.tokens || 0) + tokens,
      cost_est: Number(existing.cost_est || 0) + Number(costEst || 0),
      updated_at: new Date().toISOString()
    })
    .eq('id', existing.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getTodayUsage(salonId) {
  const day = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('usage_daily')
    .select('*')
    .eq('salon_id', salonId)
    .eq('day', day)
    .maybeSingle();

  if (error) throw error;
  return data || { messages: 0, tokens: 0, cost_est: 0 };
}

// ─── Multi-Salon ──────────────────────────────────────────────

export async function getAllSalons() {
  const { data, error } = await supabase
    .from('salons')
    .select('id, name, slug')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ─── Admin Whitelist ──────────────────────────────────────────

export async function getWhitelist() {
  const { data, error } = await supabase
    .from('admin_whitelist')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function addToWhitelist({ number, label }) {
  const { data, error } = await supabase
    .from('admin_whitelist')
    .upsert(
      { number, label, is_active: true, updated_at: new Date().toISOString() },
      { onConflict: 'number' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function removeFromWhitelist(number) {
  const { data, error } = await supabase
    .from('admin_whitelist')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('number', number)
    .select()
    .single();

  if (error) throw error;
  return data;
}