/**
 * API utility functions for making HTTP requests
 */

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

interface FetchOptions {
  headers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Make a GET request
 */
export async function get<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    ...options,
  });
  return handleResponse<T>(response);
}

/**
 * Make a POST request
 */
export async function post<T = unknown>(url: string, data: unknown, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    body: JSON.stringify(data),
    ...options,
  });
  return handleResponse<T>(response);
}

/**
 * Make a PUT request
 */
export async function put<T = unknown>(url: string, data: unknown, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    body: JSON.stringify(data),
    ...options,
  });
  return handleResponse<T>(response);
}

/**
 * Make a DELETE request
 */
export async function del<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { ...DEFAULT_HEADERS, ...options.headers },
    ...options,
  });
  return handleResponse<T>(response);
}

/**
 * Handle API response
 */
async function handleResponse<T>(response: Response): Promise<T> {
  const data = await response.json() as T;

  if (!response.ok) {
    const error = new Error((data as { error?: string }).error || "An error occurred") as Error & { status: number; data: unknown };
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

const api = { get, post, put, del };
export default api;
