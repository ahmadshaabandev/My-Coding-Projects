// Link To Card - reference URL signer for Node.js 18+ (no dependencies).
//
//   node sign.mjs [input.json]      input defaults to vector.json next to this file
//
// Copy signedCardUrl() into your server-side code. Keep the site secret on the
// server: anyone who has it can create images on your account.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

function signedCardUrl({ secret, baseUrl, siteId, template, ext = 'png', params }) {
  // The signed message is line-based, so line breaks and other control
  // characters are not allowed in values. Replace them before signing.
  const clean = {};
  for (const [name, value] of Object.entries(params)) {
    clean[name] = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
  }

  // Signed message, joined with "\n": the path, the sorted parameter names
  // joined with ",", then one "name=value" line per parameter in that order.
  // Values are the plain text, NOT URL-encoded.
  const path = `/v1/og/${siteId}/${template}.${ext}`;
  const names = Object.keys(clean).sort();
  const lines = [path, names.join(','), ...names.map((name) => `${name}=${clean[name]}`)];
  const sig = createHmac('sha256', secret).update(lines.join('\n'), 'utf8').digest('hex');

  return `${baseUrl}${path}?${new URLSearchParams({ ...clean, sig })}`;
}

const file = process.argv[2] ?? new URL('./vector.json', import.meta.url);
const input = JSON.parse(readFileSync(file, 'utf8'));
console.log(
  signedCardUrl({
    secret: input.secret,
    baseUrl: input.base_url,
    siteId: input.site_id,
    template: input.template,
    ext: input.ext,
    params: input.params,
  }),
);
