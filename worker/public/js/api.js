export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function api(method, path, body, headers = {}) {
  let res;
  try {
    res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach Tap In. Check your connection.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    const e = (data && data.error) || {};
    throw new ApiError(res.status, e.code || 'error', e.message || 'Something went wrong.');
  }
  return data;
}
export const get = (p, h) => api('GET', p, undefined, h);
export const post = (p, b = {}, h) => api('POST', p, b, h);
export const patch = (p, b) => api('PATCH', p, b);
