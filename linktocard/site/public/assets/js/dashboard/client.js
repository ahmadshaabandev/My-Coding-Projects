// The dashboard's API client. Every failure becomes an ApiFailure whose
// message is the server's own error.message, ready to show as is.
import { errorMessage } from '../api.js';
import { fontUploadUrl, parseWarnings } from './helpers.js';

export const LOGIN_URL = '/login?next=/dashboard';

class ApiFailure extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function send(path, init = {}) {
  let response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (failure) {
    if (failure?.name === 'AbortError') throw failure;
    throw new ApiFailure('The server could not be reached. Check your connection and try again.', 0);
  }
  if (response.status === 401) {
    // The session ended (or never existed): the only useful next step is to sign in.
    location.assign(LOGIN_URL);
    throw new ApiFailure('You are signed out. Taking you to the sign-in page.', 401);
  }
  if (!response.ok) throw new ApiFailure(await errorMessage(response), response.status);
  return response;
}

const jsonInit = (method, body) =>
  body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

export const api = {
  get: async (path) => (await send(path)).json(),
  post: async (path, body) => (await send(path, jsonInit('POST', body))).json(),
  put: async (path, body) => (await send(path, jsonInit('PUT', body))).json(),
  delete: async (path) => (await send(path, { method: 'DELETE' })).json(),

  /** POST /api/preview: a watermarked render that is never stored or counted. */
  async preview(payload, signal) {
    const response = await send('/api/preview', { ...jsonInit('POST', payload), signal });
    return { blob: await response.blob(), warnings: parseWarnings(response.headers.get('x-ltc-warnings')) };
  },

  /** POST /api/fonts: the descriptor in the query, the raw file as the body. */
  async uploadFont(descriptor, file) {
    const response = await send(fontUploadUrl(descriptor), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file });
    return response.json();
  },
};
