/**
 * Shared runtime state — singleton used by both index.js and dashboard.js.
 * Avoids circular dependency issues by providing a single state module.
 */

const runtime = {
    automationEnabled: true,
    salon: null,
    config: null,
    allSalons: [],             // all available salon profiles
    adminWhitelist: [],        // cached admin numbers from DB
    whatsappState: 'initializing',
    whatsappClient: null,      // reference to the active WhatsApp client for dashboard replies
    lastErrors: [],            // ring buffer of recent errors for debugging
    qr: null,                  // latest QR code connection string
    qrUpdatedAt: 0,            // timestamp of last QR generation
    whatsappStatus: 'DISCONNECTED', // DISCONNECTED, NEEDS_LINK, READY
    logBuffer: []              // ring buffer of sanitized logs for dashboard
};

const MAX_ERRORS = 20;

export function getState() {
    return runtime;
}

export function setSalon(salon) {
    runtime.salon = salon;
}

export function setConfig(config) {
    runtime.config = config;
}

export function setAllSalons(salons) {
    runtime.allSalons = salons || [];
}

export function setAdminWhitelist(list) {
    runtime.adminWhitelist = list || [];
}

export function setWhatsAppState(state) {
    runtime.whatsappState = state;

    // Map internal states to Dashboard status enum
    const up = state.toUpperCase();
    if (up === 'READY') runtime.whatsappStatus = 'READY';
    else if (up === 'NEEDS_LINK' || up === 'QR') runtime.whatsappStatus = 'NEEDS_LINK';
    else if (up === 'LINKING') runtime.whatsappStatus = 'LINKING';
    else runtime.whatsappStatus = 'DISCONNECTED';
}

export function setWhatsAppClient(client) {
    runtime.whatsappClient = client;
}

export function getWhatsAppClient() {
    return runtime.whatsappClient;
}

export function setAutomation(enabled) {
    runtime.automationEnabled = enabled;
}

export function pushError(error) {
    runtime.lastErrors.push({
        ts: new Date().toISOString(),
        msg: String(error?.message || error)
    });
    if (runtime.lastErrors.length > MAX_ERRORS) {
        runtime.lastErrors.shift();
    }
}
