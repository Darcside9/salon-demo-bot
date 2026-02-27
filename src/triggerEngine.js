/**
 * Trigger Engine — keyword-based handover detection.
 * Returns { triggered: boolean, reason: string } for a given message text.
 */

const HUMAN_REQUEST_KEYWORDS = [
    'human', 'agent', 'staff', 'person',
    'talk to someone', 'speak to someone',
    'call me', 'complaint', 'refund', 'urgent'
];

const BOOKING_INTENT_KEYWORDS = [
    'book', 'appointment', 'schedule', 'reserve',
    'available time', 'available slot',
    'book a session', 'make a booking', 'book an appointment'
];

// Simple date/time pattern for booking intent
const DATE_TIME_PATTERN = /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s*(am|pm)|next week)\b/i;

/**
 * Detect whether a message should trigger a handover.
 * @param {string} text — the customer message
 * @returns {{ triggered: boolean, reason: string }}
 */
export function detectTrigger(text) {
    const lower = String(text || '').toLowerCase().trim();
    if (!lower) return { triggered: false, reason: '' };

    // Check human request keywords
    for (const kw of HUMAN_REQUEST_KEYWORDS) {
        if (lower.includes(kw)) {
            return { triggered: true, reason: 'human_request' };
        }
    }

    // Check booking intent keywords
    for (const kw of BOOKING_INTENT_KEYWORDS) {
        if (lower.includes(kw)) {
            return { triggered: true, reason: 'booking_intent' };
        }
    }

    // Check date/time patterns (suggests booking)
    if (DATE_TIME_PATTERN.test(lower)) {
        // Only trigger on date/time if combined with service-related words
        const serviceWords = ['hair', 'nails', 'cut', 'color', 'style', 'treatment', 'massage', 'facial', 'service', 'session'];
        const hasService = serviceWords.some(w => lower.includes(w));
        if (hasService) {
            return { triggered: true, reason: 'booking_intent' };
        }
    }

    return { triggered: false, reason: '' };
}

export const HANDOVER_WAITING_MESSAGE =
    "Thanks — I'm handing this over to a staff member now. They'll reply shortly.";
