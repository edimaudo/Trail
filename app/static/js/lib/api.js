import { getAppCheckToken } from './firebase.js';
export async function apiGet(path) {
    const response = await fetch(path, { headers: await authHeaders(), cache: 'no-store' });
    return readResponse(response);
}
export async function apiPost(path, body) {
    const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify(body),
    });
    return readResponse(response);
}
async function authHeaders() {
    try {
        const token = await getAppCheckToken();
        return token ? { 'X-Firebase-AppCheck': token } : {};
    }
    catch (error) {
        if (window.TRAIL_CONFIG?.appCheckEnforced)
            throw new Error(`Could not obtain a Firebase App Check token: ${message(error)}`);
        return {};
    }
}
async function readResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
        throw new Error(payload.detail || `FastAPI request failed (${response.status}).`);
    return payload;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
