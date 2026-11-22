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
  return `Request failed (HTTP ${response.status}).`;
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
