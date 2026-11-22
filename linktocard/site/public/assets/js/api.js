// Small fetch helpers shared by the page scripts. The API's error body is
// { "error": { "code", "message", "docs" } } (src/lib/errors.ts).

/** The API's own error message, or a plain fallback when the body is not that shape. */
export async function errorMessage(response) {
  try {
    const body = await response.json();
    if (typeof body?.error?.message === 'string') return body.error.message;
  } catch {
    // Not JSON (for example an HTML error page): fall through to the generic message.
  }
  return fallbackMessage(response.status);
}

/** What to tell a visitor when the answer carries no message of ours (a proxy or platform error page). */
export function fallbackMessage(status) {
  if (status === 429) return 'Too many requests in a short time. Wait a minute, then try again.';
  if (status >= 500) return `The server had a problem (HTTP ${status}). Wait a minute, then try again.`;
  return `Request failed (HTTP ${status}). Reload the page and try again.`;
}

/** POSTs JSON and returns the parsed response; rejects with the API's message on a non-2xx answer. */
export async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return response.json();
}
