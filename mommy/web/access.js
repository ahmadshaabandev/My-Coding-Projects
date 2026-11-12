/*
 * access.js: the access gate of an online Mommy (web/access.html; the server side is
 * backend/mommy/access.py and docs/CONTRACT.md, "Access gate").
 *
 * - The language follows navigator.language: Arabic (right to left), French, or English.
 * - A link https://<host>/#code=<code> opens the app: the fragment is removed from the
 *   address bar and from this tab's history entry at once (history.replaceState), then
 *   the code is POSTed to /api/access, which answers 204 with an HttpOnly cookie, and the
 *   page goes to "/". A URL fragment is never sent to a server, so the code never reaches
 *   a server log; it is never put in a query string either. The browser's own history
 *   list (and its sync, and address-bar suggestions) still holds the link as it was
 *   opened: on a shared device, delete that entry, or ask the owner for a new code.
 * - The same happens when the link is pasted into a tab that already shows this page
 *   (only the fragment changes, so the page is not loaded again: "hashchange").
 * - Otherwise, or when the code is refused, a form asks for it, with a translated error.
 *   While the app is starting (the proxy answers 502, 503 or 504) or cannot be reached,
 *   a link's code is kept in memory: it is tried once more by itself after 20 s, and
 *   "Enter" with an empty field tries it again.
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
      err_starting: 'The app is starting. Please wait a minute and try again.',
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
      err_starting: 'L’application démarre. Veuillez patienter une minute, puis réessayer.',
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
      err_starting: 'جارٍ تشغيل التطبيق. يُرجى الانتظار دقيقة واحدة ثم المحاولة من جديد.',
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

  /** The code of a #code=... link (or null), removed from the address bar and this
   * tab's history entry before anything else happens. */
  function takeLinkCode() {
    if (!/(^#|&)code=/.test(location.hash)) return null;
    const code = new URLSearchParams(location.hash.slice(1)).get('code');
    history.replaceState(null, '', location.pathname + location.search);
    return code;
  }

  const firstLinkCode = takeLinkCode();
  /** How long a link's code waits before it is tried once more, while the app starts. */
  const RETRY_MS = 20000;

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
  // A link's code whose try failed for a passing reason (the app starting, no network):
  // kept in memory only, for "Enter" with an empty field and for one automatic retry.
  let pendingLinkCode = null;
  let retryTimer = null;

  function cancelRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function showError(key, vars) {
    busy = false;
    submit.disabled = false;
    status.textContent = '';
    form.hidden = false;
    error.textContent = t(key, vars);
    input.focus();
    input.select();
  }

  /** A passing failure of a link's code: keep it, and try it once more after RETRY_MS. */
  function keepLinkCode(code, retryLater) {
    pendingLinkCode = code;
    if (retryLater) {
      cancelRetry();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!busy && pendingLinkCode === code) tryCode(code, { link: true, retry: false });
      }, RETRY_MS);
    }
  }

  /** POST `code`. how.link: it came from a link; how.retry: one automatic retry allowed. */
  async function tryCode(code, how) {
    const h = how || {};
    cancelRetry();
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
      if (h.link) keepLinkCode(code, h.retry);
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
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // The proxy answers this while the Space starts (after a deploy, a restart or sleep).
      if (h.link) keepLinkCode(code, h.retry);
      showError('err_starting');
      return;
    }
    pendingLinkCode = null;
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
    const typed = input.value.trim();
    if (typed) {
      pendingLinkCode = null;
      tryCode(typed);
    } else if (pendingLinkCode) {
      tryCode(pendingLinkCode, { link: true, retry: false });
    } else {
      showError('err_empty');
    }
  });

  /** Use the code of a link: hide the form and try it (one automatic retry allowed). */
  function useLinkCode(code) {
    pendingLinkCode = null;
    form.hidden = true;
    tryCode(code, { link: true, retry: true });
  }

  // The link pasted into this tab while it shows the code page: only the fragment
  // changes, so the page is not loaded again. The fragment is removed at once, always.
  window.addEventListener('hashchange', () => {
    const code = takeLinkCode();
    if (code && !busy) useLinkCode(code);
  });

  if (firstLinkCode) {
    useLinkCode(firstLinkCode);
  } else {
    input.focus();
  }
})();
