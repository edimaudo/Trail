import { getAppCheckToken } from './firebase';

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: await authHeaders(), cache: 'no-store' });
  return readResponse<T>(response);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  return readResponse<T>(response);
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getAppCheckToken();
    return token ? { 'X-Firebase-AppCheck': token } : {};
  } catch (error) {
    if (window.TRAIL_CONFIG?.appCheckEnforced) throw new Error(`Could not obtain a Firebase App Check token: ${message(error)}`);
    return {};
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as { detail?: string };
  if (!response.ok) throw new Error(payload.detail || `FastAPI request failed (${response.status}).`);
  return payload as T;
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
