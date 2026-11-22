// /login/verify: the emailed link lands here. The token is only sent when the
// person presses the button, so mail scanners that pre-fetch links cannot use it up.
import { postJson } from './api.js';

const params = new URLSearchParams(location.search);
const token = params.get('token');
const next = params.get('next') ?? undefined;
const ready = document.querySelector('#verify-ready');
const failed = document.querySelector('#verify-failed');
const button = document.querySelector('#verify-button');

function fail(message) {
  failed.querySelector('[data-message]').textContent = message;
  ready.hidden = true;
  failed.hidden = false;
}

if (!token) {
  fail('This sign-in link is incomplete. Request a new one.');
} else {
  button.disabled = false;
  button.addEventListener('click', async () => {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    try {
      const result = await postJson('/auth/verify', { token, next });
      location.assign(typeof result.redirect === 'string' ? result.redirect : '/dashboard');
    } catch (failure) {
      fail(failure.message || 'This sign-in link has expired or was already used.');
    }
  });
}
