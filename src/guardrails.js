import { getState } from './runtimeState.js';

export function normalizeNumber(raw) {
  return String(raw || '')
    .replace('@c.us', '')
    .replace('@g.us', '')
    .replace('@lid', '')
    .trim();
}

/** Check if number is in the admin whitelist (DB-backed, cached in runtime state) */
export function isAdmin(rawNumber) {
  const n = normalizeNumber(rawNumber);
  const whitelist = getState().adminWhitelist || [];
  return whitelist.some(entry => entry.number === n && entry.is_active);
}

// Backwards compatibility alias
export const isOwner = isAdmin;

export function isCommand(text) {
  return typeof text === 'string' && text.trim().startsWith('/');
}

export function canUseAutomationForChat({ isGroup = false }) {
  // Demo-safe default: ignore groups
  return !isGroup;
}

export function estimateCostFromTokens(tokens) {
  // rough placeholder estimate for demo tracking
  // adjust later per actual model pricing
  const per1k = 0.0015; // demo roughness
  return (tokens / 1000) * per1k;
}
