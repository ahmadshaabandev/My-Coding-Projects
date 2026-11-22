// /login: asks the API to email a sign-in link.
import { postJson } from './api.js';

const form = document.querySelector('#login-form');
const sent = document.querySelector('#login-sent');
const error = document.querySelector('#login-error');
const button = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  const email = form.elements.email.value.trim();
  const next = new URLSearchParams(location.search).get('next') ?? undefined;
  try {
    const result = await postJson('/auth/magic-link', { email, next });
    form.hidden = true;
    document.querySelector('#login-intro').hidden = true;
    sent.querySelector('[data-email]').textContent = email;
    // dev_link is only ever returned by a local development server.
    if (typeof result.dev_link === 'string') {
      const link = sent.querySelector('#login-dev-link');
      link.href = result.dev_link;
      link.parentElement.hidden = false;
    }
    sent.hidden = false;
    sent.focus();
  } catch (failure) {
    error.textContent = failure.message || 'The sign-in link could not be sent.';
    error.hidden = false;
  }
  button.removeAttribute('aria-busy');
  button.disabled = false;
});
