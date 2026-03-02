import { getState } from './runtimeState.js';

// Max lines to keep in memory for the dashboard logs panel
const MAX_LOG_LINES = 200;

/**
 * Sanitizes a string by redacting things that look like secrets.
 * Masks: Bearer tokens, gsk_ (Groq) keys, sk- (OpenAI/Anthropic) keys, 
 * Supabase keys (eyJhbGci...), Telegram bot tokens (number:string).
 */
function sanitizeLog(text) {
    if (typeof text !== 'string') return text;

    // Redact Bearer tokens
    let sanitized = text.replace(/Bearer [A-Za-z0-9\-_.]+/g, 'Bearer [REDACTED]');
    // Redact Groq keys
    sanitized = sanitized.replace(/gsk_[A-Za-z0-9]{30,}/g, 'gsk_[REDACTED]');
    // Redact generic sk- keys
    sanitized = sanitized.replace(/sk-[A-Za-z0-9\-_]{20,}/g, 'sk-[REDACTED]');
    // Redact JWTs (often Supabase anon/service keys) starting with eyJhbGci
    sanitized = sanitized.replace(/eyJhbGci[A-Za-z0-9\-_.]+/g, 'eyJhbGci[REDACTED]');
    // Redact Telegram bot tokens (digits:alphanumeric)
    sanitized = sanitized.replace(/\d{9,10}:[A-Za-z0-9_-]{35,}/g, '[TELEGRAM_TOKEN_REDACTED]');

    return sanitized;
}

/**
 * Custom logger that writes to stdout/stderr and also buffers sanitized
 * logs into runtimeState for the dashboard Live Logs panel.
 */
export const logger = {
    info: (...args) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.log(msg); // Output to real console

        const state = getState();
        state.logBuffer.push({
            ts: Date.now(),
            level: 'info',
            text: sanitizeLog(msg)
        });

        if (state.logBuffer.length > MAX_LOG_LINES) {
            state.logBuffer.shift();
        }
    },
    error: (...args) => {
        const msg = args.map(a => typeof a === 'object' && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        console.error(msg);

        const state = getState();
        state.logBuffer.push({
            ts: Date.now(),
            level: 'error',
            text: sanitizeLog(msg)
        });

        if (state.logBuffer.length > MAX_LOG_LINES) {
            state.logBuffer.shift();
        }
    },
    warn: (...args) => {
        const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
        console.warn(msg);

        const state = getState();
        state.logBuffer.push({
            ts: Date.now(),
            level: 'warn',
            text: sanitizeLog(msg)
        });

        if (state.logBuffer.length > MAX_LOG_LINES) {
            state.logBuffer.shift();
        }
    }
};
