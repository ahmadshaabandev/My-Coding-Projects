/*
 * access.js: the access gate of an online Mommy (web/access.html; the server side is
 * backend/mommy/access.py and docs/CONTRACT.md, "Access gate").
 *
 * - The language follows navigator.language: Arabic (right to left), French, or English.
 * - A link https://<host>/#code=<code> opens the app: the fragment is removed from the
 *   address bar and the history at once (history.replaceState), then the code is POSTed
 *   to /api/access, which answers 204 with an HttpOnly cookie, and the page goes to "/".
 *   A URL fragment is never sent to a server, so the code never reaches a server log;
 *   it is never put in a query string either.
 * - Otherwise, or when the code is refused, a form asks for it, with a translated error.
 * No external request, no inline script; nothing is stored by this script.
 */
(function () {
  'use strict';

  const STRINGS = {
    en: {
      doc_title: 'Mommy — private test',
      title: 'This is a private test of Mommy.',
      label: 'Access code',
      hint: 'Please type the access code that came with the link.',
      submit: 'Enter',
      checking: 'Checking the code…',
      err_empty: 'Please type the access code.',
      err_bad: 'This code is not right. Please check it and try again.',
      err_many: 'Too many tries. Please wait {wait} and try again.',
      err_network: 'The server could not be reached. Please try again.',
      err_other: 'Something went wrong. Please try again.',
      minutes_one: '1 minute',
      minutes_other: '{n} minutes',
    },
    fr: {
      doc_title: 'Mommy — test privé',
      title: 'Ceci est un test privé de Mommy.',
      label: 'Code d’accès',
      hint: 'Veuillez saisir le code d’accès reçu avec le lien.',
      submit: 'Entrer',
      checking: 'Vérification du code…',
      err_empty: 'Veuillez saisir le code d’accès.',
      err_bad: 'Ce code n’est pas le bon. Veuillez le vérifier et réessayer.',
      err_many: 'Trop d’essais. Veuillez patienter {wait}, puis réessayer.',
      err_network: 'Le serveur ne répond pas. Veuillez réessayer.',
      err_other: 'Une erreur s’est produite. Veuillez réessayer.',
      minutes_one: '1 minute',
      minutes_other: '{n} minutes',
    },
    ar: {
      doc_title: 'Mommy — نسخة تجريبية خاصة',
      title: 'هذه نسخة تجريبية خاصة من Mommy.',
      label: 'رمز الدخول',
      hint: 'يُرجى إدخال رمز الدخول المرفق بالرابط.',
      submit: 'دخول',
      checking: 'جارٍ التحقق من الرمز…',
      err_empty: 'يُرجى إدخال رمز الدخول.',
      err_bad: 'هذا الرمز غير صحيح. يُرجى التحقق منه ثم المحاولة من جديد.',
      err_many: 'محاولات كثيرة. يُرجى الانتظار {wait} ثم المحاولة من جديد.',
      err_network: 'تعذّر الوصول إلى الخادم. يُرجى المحاولة من جديد.',
      err_other: 'حدث خطأ ما. يُرجى المحاولة من جديد.',
      minutes_one: 'دقيقة واحدة',
      minutes_two: 'دقيقتين',
      minutes_few: '{n} دقائق',
      minutes_many: '{n} دقيقة',
    },
  };

  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  /** ar, fr or en, from the browser's language. */
  function pickLang() {
    const l = String(navigator.language || 'en').toLowerCase();
    if (l.startsWith('ar')) return 'ar';
    if (l.startsWith('fr')) return 'fr';
    return 'en';
  }

  const lang = pickLang();

  function num(n) {
    return lang === 'ar' ? String(n).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]) : String(n);
  }

  function t(key, vars) {
    let s = STRINGS[lang][key] || STRINGS.en[key] || key;
    for (const [k, v] of Object.entries(vars || {})) s = s.split('{' + k + '}').join(String(v));
    return s;
  }

  /** "N minutes" for a wait of `seconds` (rounded up; Arabic singular, dual and plurals). */
  function minutes(seconds) {
    const n = Math.max(1, Math.ceil(seconds / 60));
    if (lang === 'ar') {
      const key = n === 1 ? 'minutes_one' : n === 2 ? 'minutes_two' : n <= 10 ? 'minutes_few' : 'minutes_many';
      return t(key, { n: num(n) });
    }
    return t(n === 1 ? 'minutes_one' : 'minutes_other', { n: num(n) });
  }

  // The code of a #code=... link, removed from the address bar (and its history entry)
  // before anything else happens.
  let linkCode = null;
  if (/(^#|&)code=/.test(location.hash)) {
    linkCode = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(null, '', location.pathname + location.search);
  }

  const root = document.documentElement;
  root.lang = lang;
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('doc_title');
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);

  const form = document.getElementById('access-form');
  const input = document.getElementById('access-code');
  const status = document.getElementById('access-status');
  const error = document.getElementById('access-error');
  const submit = document.getElementById('access-submit');
  let busy = false;

  function showError(key, vars) {
    busy = false;
    submit.disabled = false;
    status.textContent = '';
    form.hidden = false;
    error.textContent = t(key, vars);
    input.focus();
    input.select();
  }

  async function tryCode(code) {
    busy = true;
    submit.disabled = true;
    error.textContent = '';
    status.textContent = t('checking');
    let res;
    try {
      res = await fetch('/api/access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code }),
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (e) {
      showError('err_network');
      return;
    }
    // 404: this server has no gate (no access code is set), so the app is open.
    if (res.status === 204 || res.status === 404) {
      location.replace('/');
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
    const errorCode = body && body.error;
    if (res.status === 429 || errorCode === 'too_many_attempts') {
      const wait = Number(res.headers.get('Retry-After'));
      showError('err_many', { wait: minutes(Number.isFinite(wait) && wait > 0 ? wait : 600) });
    } else if (errorCode === 'bad_access_code') {
      showError('err_bad');
    } else {
      showError('err_other');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    const code = input.value.trim();
    if (!code) {
      showError('err_empty');
      return;
    }
    tryCode(code);
  });

  if (linkCode) {
    form.hidden = true;
    tryCode(linkCode);
  } else {
    input.focus();
  }
})();
