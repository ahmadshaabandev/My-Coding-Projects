// /contact: sends the form as JSON. Without JavaScript the form falls back to mailto.
import { postJson } from './api.js';

const form = document.querySelector('#contact-form');
const done = document.querySelector('#contact-done');
const error = document.querySelector('#contact-error');
const button = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.hidden = true;
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    await postJson('/api/contact', {
      email: form.elements.email.value.trim(),
      message: form.elements.message.value.trim(),
      website: form.elements.website.value,
    });
    form.hidden = true;
    done.hidden = false;
    done.focus();
  } catch (failure) {
    error.textContent = failure.message || 'The message could not be sent.';
    error.hidden = false;
  }
  button.removeAttribute('aria-busy');
  button.disabled = false;
});
