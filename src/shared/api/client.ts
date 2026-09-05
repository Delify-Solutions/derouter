/**
 * Typed API client for the derouter-rs JSON API.
 * All requests include credentials (cookies) and use JSON.
 * Base URL is configured via NEXT_PUBLIC_API_URL env var.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:20128';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (!res.ok) {
    let errBody: unknown;
    let msg = `HTTP ${res.status}`;
    try {
      errBody = await res.json();
      if (errBody && typeof errBody === 'object' && 'error' in errBody) {
        msg = String((errBody as { error: unknown }).error);
      }
    } catch {
      try {
        msg = await res.text();
      } catch {
        /* ignore */
      }
    }
    throw new ApiError(res.status, msg, errBody);
  }

  // Handle 204 No Content
  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export async function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/**
 * Open a streaming response (SSE/ndbytes) with credentials.
 * Returns the raw Response so callers can read res.body.getReader().
 * For non-ok responses, throws ApiError like request<T>.
 */
export async function apiStream(path: string, body?: unknown): Promise<Response> {
  const url = `${API_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream,application/json',
  };
  const init: RequestInit = { method: body !== undefined ? 'POST' : 'GET', headers, credentials: 'include' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    let errBody: unknown;
    let msg = `HTTP ${res.status}`;
    try {
      errBody = await res.json();
      if (errBody && typeof errBody === 'object' && 'error' in errBody) {
        msg = String((errBody as { error: unknown }).error);
      }
    } catch { /* streaming body, not JSON */ }
    throw new ApiError(res.status, msg, errBody);
  }
  return res;
}
