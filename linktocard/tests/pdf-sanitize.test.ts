// Sanitising of PDF documents (src/pdf/template.ts, src/pdf/css.ts) and the bundled fonts
// (src/pdf/fonts.ts): one test per removed element, attribute and URL scheme.
import { describe, expect, it } from 'vitest';
import { PDF } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { bundledFontFaces, subsetsFor } from '../src/pdf/fonts';
import { buildPdfDocument, preparePdfDocument, preparePdfFragment, type PdfData } from '../src/pdf/template';

const body = (html: string, data: PdfData = {}): string => /<body[^>]*>([\s\S]*)<\/body><\/html>$/.exec(buildPdfDocument({ html, css: '', data }))![1]!;
const head = (html: string, css = ''): string => /<head>([\s\S]*)<\/head>/.exec(buildPdfDocument({ html, css, data: {} }))![1]!;
const warningsOf = (html: string, css = ''): string[] => preparePdfDocument({ html, css, data: {} }).warnings;

function errorOf(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected an ApiError');
}

describe('elements removed with their content', () => {
  it.each([
    ['script', '<script>alert(1)</script>'],
    ['noscript', '<noscript><p>shown when scripts are off</p></noscript>'],
    ['template', '<template shadowrootmode="open"><p>shadow</p></template>'],
    ['iframe', '<iframe src="https://example.com"></iframe>'],
    ['frame', '<frameset><frame src="https://example.com"></frameset>'],
    ['frameset', '<frameset cols="50%"></frameset>'],
    ['object', '<object data="https://example.com/x.swf"><param name="a" value="b"></object>'],
    ['embed', '<embed src="https://example.com/x.swf">'],
    ['applet', '<applet code="X.class"></applet>'],
    ['base', '<base href="https://evil.example/">'],
    ['meta http-equiv', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/a.css">'],
    ['link preload', '<link rel="preload" href="https://evil.example/a.png" as="image">'],
    ['portal', '<portal src="https://example.com"></portal>'],
    ['xmp (raw text)', '<xmp>{{v}}</xmp>'],
    ['noembed (raw text)', '<noembed>{{v}}</noembed>'],
    ['noframes (raw text)', '<noframes>{{v}}</noframes>'],
    ['video', '<video src="https://example.com/a.mp4" poster="https://example.com/p.png"></video>'],
    ['audio', '<audio src="https://example.com/a.mp3"></audio>'],
    ['source', '<picture><source srcset="https://example.com/a.webp"></picture>'],
    ['track', '<track src="https://example.com/a.vtt">'],
  ])('<%s>', (_label, markup) => {
    const out = body(`<div>${markup}</div><p>kept</p>`, { v: '</xmp><img src=x>' });
    expect(out.replace('<picture></picture>', '')).toBe('<div></div><p>kept</p>');
  });

  it.each([
    ['script', '<script>alert(1)</script>'],
    ['animate', '<a href="#a"><animate attributeName="href" to="javascript:alert(1)"/></a>'],
    ['set', '<set attributeName="href" to="javascript:alert(1)"/>'],
    ['animateTransform', '<animateTransform attributeName="transform" type="rotate"/>'],
  ])('<%s> inside <svg>', (_label, markup) => {
    expect(body(`<svg viewBox="0 0 10 10">${markup}<rect width="1" height="1"/></svg>`)).not.toMatch(/script|animate|<set/i);
  });

  // A browser's HTML parser lets <meta> and <embed> break out of SVG, and <foreignObject> holds
  // HTML, so the HTML drop list applies inside <svg> as well.
  it.each([
    ['meta http-equiv', '<meta http-equiv="refresh" content="1;url=https://evil.example/">'],
    ['meta in foreignObject', '<foreignObject><meta http-equiv="refresh" content="1;url=https://evil.example/"></foreignObject>'],
    ['embed', '<embed type="text/html">'],
    ['iframe and object in foreignObject', '<foreignObject><iframe srcdoc="x"></iframe><object type="text/html"></object></foreignObject>'],
    ['link and base', '<link rel="stylesheet" href="#a"><base href="#b">'],
    ['noscript and template', '<noscript><text>y</text></noscript><template><text>x</text></template>'],
  ])('HTML-only <%s> inside <svg>', (_label, markup) => {
    expect(body(`<svg viewBox="0 0 10 10">${markup}<rect width="1" height="1"/></svg>`)).toMatch(
      /^<svg viewBox="0 0 10 10">(?:<foreignObject\/>)?<rect width="1" height="1"\/><\/svg>$/,
    );
  });

  it('keeps ordinary SVG, foreignObject content included', () => {
    const svg = '<svg viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><foreignObject width="10" height="10"><p>x</p></foreignObject><text>t</text></svg>';
    expect(body(svg)).toBe(svg);
  });

  it('says what it removed', () => {
    expect(warningsOf('<script>x</script>')).toEqual(['<script> is not allowed in PDF documents and was removed.']);
  });

  it('drops comments, doctypes and processing instructions', () => {
    expect(body('<!doctype html><!-- secret --><?xml version="1.0"?><p>x</p>')).toBe('<p>x</p>');
  });
});

describe('attributes', () => {
  it('drops every on* attribute, in any case', () => {
    expect(body('<p onclick="a()" ONMOUSEOVER="b()" onLoad="c()" class="k">x</p><svg onload="d()"><rect onclick="e()"/></svg>')).toBe(
      '<p class="k">x</p><svg><rect/></svg>',
    );
  });

  it.each(['srcset', 'poster', 'background', 'lowsrc', 'dynsrc', 'longdesc', 'ping', 'action', 'formaction', 'manifest', 'srcdoc', 'xml:base'])(
    'drops %s',
    (attribute) => {
      expect(body(`<div ${attribute}="https://evil.example/x" class="k">x</div>`)).toBe('<div class="k">x</div>');
    },
  );

  it('drops loading, so an image is never left unloaded when the page is printed', () => {
    expect(body('<img src="data:image/png;base64,AAAA" loading="lazy">')).toBe('<img src="data:image/png;base64,AAAA">');
  });

  it('keeps form controls but makes forms inert', () => {
    expect(body('<form action="https://evil.example/post" method="post"><input name="q" value="1"><button formaction="javascript:x()">Go</button></form>')).toBe(
      '<form method="post"><input name="q" value="1"><button>Go</button></form>',
    );
  });

  it('keeps src only on <img>', () => {
    expect(body('<input type="image" src="https://evil.example/a.png"><div src="https://evil.example/x">x</div>')).toBe('<input type="image"><div>x</div>');
  });

  it('keeps href only on links, and drops attribute names that cannot be serialised safely', () => {
    expect(body('<div href="https://example.com" xlink:href="#a" a"b="1">x</div>')).toBe('<div>x</div>');
  });

  it('drops presentation attributes that load something through url()', () => {
    expect(body('<svg><rect fill="url(https://evil.example/p.svg#g)" stroke="url(#ok)"/></svg>')).toBe('<svg><rect stroke="url(#ok)"/></svg>');
  });

  it('keeps title, alt, data-* and other HTML attributes with a Windows path, a regex or LaTeX', () => {
    const data = { path: 'C:\\Users\\Ada\\report (final).pdf', regex: '^\\d+(\\.\\d+)?$', tex: '\\frac{a}{b} \\left( x \\right)' };
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const html = `<p title="{{path}}">x</p><img alt="{{path}}" src="${png}"><table><tr><td data-note="{{path}}" aria-label="{{regex}}">y</td></tr></table><abbr title="{{tex}}">z</abbr>`;
    const prepared = preparePdfDocument({ html, css: '', data });
    const out = /<body>([\s\S]*)<\/body>/.exec(prepared.render(() => undefined))![1]!;
    expect(out).toContain('<p title="C:\\Users\\Ada\\report (final).pdf">x</p>');
    expect(out).toContain(`<img alt="C:\\Users\\Ada\\report (final).pdf" src="${png}">`);
    expect(out).toContain('<td data-note="C:\\Users\\Ada\\report (final).pdf" aria-label="^\\d+(\\.\\d+)?$">y</td>');
    expect(out).toContain('<abbr title="\\frac{a}{b} \\left( x \\right)">z</abbr>');
    expect(prepared.warnings).toEqual([]);
    // Inside <svg> too, as long as the attribute is not one Chrome reads as CSS.
    expect(body('<svg><text data-path="{{path}}" aria-label="{{path}}">p</text></svg>', data)).toBe(
      '<svg><text data-path="C:\\Users\\Ada\\report (final).pdf" aria-label="C:\\Users\\Ada\\report (final).pdf">p</text></svg>',
    );
    // A paid header or footer keeps them as well.
    expect(preparePdfFragment('<span title="{{path}}">{{path}}</span>', data, 'footer').render(() => undefined)).toBe(
      '<span title="C:\\Users\\Ada\\report (final).pdf">C:\\Users\\Ada\\report (final).pdf</span>',
    );
  });

  it('still drops an SVG presentation attribute with a backslash and a "(", which Chrome reads as CSS', () => {
    const data = { path: 'C:\\Users\\Ada\\report (final).pdf' };
    expect(body('<svg><rect fill="{{path}}" stroke="{{path}}" width="10"/></svg>', data)).toBe('<svg><rect width="10"/></svg>');
    // On an HTML element the same name is not CSS.
    expect(body('<p fill="{{path}}">x</p>', data)).toBe('<p fill="C:\\Users\\Ada\\report (final).pdf">x</p>');
  });

  it('checks attribute values after the placeholders are filled in', () => {
    expect(body('<a href="{{link}}">pay</a>', { link: 'javascript:alert(1)' })).toBe('<a>pay</a>');
    expect(body('<a href="{{link}}">pay</a>', { link: 'https://pay.example.com/i/1' })).toBe('<a href="https://pay.example.com/i/1">pay</a>');
  });
});

describe('link targets', () => {
  it.each(['https://example.com/a', 'http://example.com/a', 'mailto:billing@example.com', 'tel:+15550100', '#totals'])('keeps %s on <a>', (href) => {
    expect(body(`<a href="${href}">x</a>`)).toBe(`<a href="${href}">x</a>`);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['JavaScript: with entities and white space', ' JaVa&#x09;Script:alert(1)'],
    ['javascript: split by a newline', 'java\nscript:alert(1)'],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['a relative URL', '/pricing'],
  ])('drops %s on <a> and <area>', (_label, href) => {
    expect(body(`<a href="${href.replace(/"/g, '&quot;')}">x</a><map><area href="${href.replace(/"/g, '&quot;')}"></map>`)).toBe('<a>x</a><map><area></map>');
  });

  it('allows only #id references inside <svg>, plus https links on SVG <a> and data:image on <image>', () => {
    const svg =
      '<svg><use href="#icon"/><use href="https://evil.example/s.svg#icon"/><use xlink:href="javascript:alert(1)"/>' +
      '<a href="https://example.com"><text>x</text></a><image href="data:image/png;base64,AAAA"/><image href="https://evil.example/a.png"/></svg>';
    expect(body(svg)).toBe('<svg><use href="#icon"/><use/><use/><a href="https://example.com"><text>x</text></a><image href="data:image/png;base64,AAAA"/><image/></svg>');
  });

  it('reports removed javascript: links', () => {
    expect(warningsOf('<a href="javascript:x()">x</a>')).toContain('javascript: and vbscript: links were removed.');
  });
});

describe('<img src>', () => {
  it('keeps data:image URIs and collects http(s) URLs for inlining', () => {
    const prepared = preparePdfDocument({ html: '<img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="https://cdn.example.com/a b.png">', css: '', data: {} });
    expect(prepared.remoteUrls).toEqual(['https://cdn.example.com/a%20b.png']);
    expect(prepared.render(() => 'data:image/png;base64,QQ==')).toContain('<img src="data:image/svg+xml;base64,PHN2Zy8+"><img src="data:image/png;base64,QQ==">');
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'logo.png', '//cdn.example.com/a.png'])('drops src="%s"', (src) => {
    expect(body(`<img src="${src}" alt="logo">`)).toBe('<img alt="logo">');
  });

  it('leaves out an <img> whose src is empty once filled in (an optional logo)', () => {
    expect(body('<header><img class="logo" src="{{logo_url}}" alt=""><h1>Invoice</h1></header>')).toBe('<header><h1>Invoice</h1></header>');
  });

  it('refuses more distinct remote images than PDF.maxRemoteAssets', () => {
    const images = Array.from({ length: PDF.maxRemoteAssets + 1 }, (_, i) => `<img src="https://cdn.example.com/${i}.png">`).join('');
    const error = errorOf(() => preparePdfDocument({ html: images, css: '', data: {} }));
    expect(error.code).toBe('template_error');
    expect(error.details).toMatchObject({ limit: PDF.maxRemoteAssets });
  });
});

describe('CSS', () => {
  it('refuses @import, also inside @media and in a <style> element', () => {
    for (const css of ['@import url(https://evil.example/a.css);', '@media print { @import "x.css"; }']) {
      const error = errorOf(() => buildPdfDocument({ html: '<p>x</p>', css, data: {} }));
      expect(error.code).toBe('template_error');
      expect(error.message).toContain('@import is not supported');
    }
    expect(errorOf(() => body('<style>@IMPORT "x.css";</style>')).code).toBe('template_error');
  });

  it('refuses @import written with no space before its string, as a browser still reads it', () => {
    for (const css of ['@import"https://evil.example/a.css";', "@import'https://evil.example/a.css';", '@import/**/url(https://evil.example/a.css);']) {
      expect(errorOf(() => buildPdfDocument({ html: '<p>x</p>', css, data: {} })).message, css).toContain('@import is not supported');
    }
  });

  it('reads other at-rule names the same way: @namespace and @charset are dropped however they are written', () => {
    const prepared = preparePdfDocument({ html: '<p>x</p>', css: '@namespace"https://evil.example/ns"; @charset"utf-8"; .k { color: red }', data: {} });
    expect(prepared.render(() => undefined)).toContain('<style>.k{color:red;}</style>');
    expect(prepared.warnings).toEqual(['@namespace is not supported and was ignored.']);
  });

  it('refuses an at-rule name written with escapes', () => {
    expect(errorOf(() => buildPdfDocument({ html: '<p>x</p>', css: '@\\69mport "x.css";', data: {} })).message).toContain('CSS escapes');
  });

  it('refuses @font-face with an external font, keeps one with a data: font', () => {
    const external = errorOf(() => buildPdfDocument({ html: '<p>x</p>', css: "@font-face { font-family: X; src: url(https://fonts.example.com/x.woff2) }", data: {} }));
    expect(external.code).toBe('template_error');
    expect(external.message).toContain('@font-face may only use fonts embedded as data: URIs');
    expect(head('<p>x</p>', "@font-face { font-family: X; src: url(data:font/woff2;base64,AAAA) format('woff2'), local(Arial) }")).toContain(
      '@font-face{font-family:X;src:url("data:font/woff2;base64,AAAA") format(\'woff2\'), local(Arial);}',
    );
  });

  it('collects http(s) url() for inlining and keeps #fragments and data: URIs', () => {
    const prepared = preparePdfDocument({
      html: '<p style="background-image: url(\'https://cdn.example.com/s.png\')">x</p>',
      css: '.a { background: url(https://cdn.example.com/a.png) } .b { filter: url(#blur); mask: url(\'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>\') }',
      data: {},
    });
    expect(prepared.remoteUrls).toEqual(['https://cdn.example.com/a.png', 'https://cdn.example.com/s.png']);
    const html = prepared.render(() => 'data:image/png;base64,QQ==');
    expect(html).toContain('.a{background:url("data:image/png;base64,QQ==");}');
    expect(html).toContain('.b{filter:url("#blur");mask:url("data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>");}');
    expect(html).toContain('style="background-image:url(&quot;data:image/png;base64,QQ==&quot;)"');
  });

  it.each([
    ['a relative url()', '.a { background: url(bg.png) }'],
    ['javascript: in url()', '.a { background: url(javascript:alert(1)) }'],
    ['a url() written with escapes', '.a { background: u\\72l(https://evil.example/a.png) }'],
    ['an escaped url() string', '.a { background: url("https:\\2f\\2f evil.example/a.png") }'],
    ['image-set() with plain strings', '.a { background-image: image-set("https://evil.example/a.png" 1x) }'],
    ['an unparseable url(', '.a { background: url(https://evil.example/a.png }'],
    ['url(var(...))', '.a { background: url(var(--x)) }'],
    ['src() with a string', '.a { background: src("https://evil.example/a.png") }'],
  ])('drops a declaration with %s', (_label, css) => {
    const prepared = preparePdfDocument({ html: '<p>x</p>', css: `.k { color: red } ${css}`, data: {} });
    expect(prepared.remoteUrls).toEqual([]);
    const html = prepared.render(() => undefined);
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/background/);
    expect(html).toContain('.k{color:red;}');
    expect(prepared.warnings.length).toBeGreaterThan(0);
  });

  it('keeps image-set() whose images are url() tokens', () => {
    const prepared = preparePdfDocument({ html: '<p>x</p>', css: '.a { background-image: image-set(url(https://cdn.example.com/a.png) 1x) }', data: {} });
    expect(prepared.remoteUrls).toEqual(['https://cdn.example.com/a.png']);
  });

  it('drops @namespace, @charset and @page, keeps @media and nested rules', () => {
    // @page is dropped: the paper size, orientation and margins come from "pdf" alone. Chrome
    // would otherwise let @page margins override the request's (and the free mark's room), and
    // follow its orientation keyword whatever "landscape" says.
    const css = '@charset "utf-8"; @namespace svg url(http://www.w3.org/2000/svg); @page { size: A4; margin: 1cm; @bottom-center { content: counter(page) } } @media print { .a { color: red } }';
    expect(head('<p>x</p>', css)).toContain('<style>@media print{.a{color:red;}}</style>');
    expect(warningsOf('<p>x</p>', css)).toContain('Page size, orientation and margins come from "pdf" (format, landscape, margin); the CSS @page rule was ignored.');
  });

  it.each([
    ['nested in @media', '@media print { @page { size: landscape } .a { color: red } }', '@media print{.a{color:red;}}'],
    ['nested in @supports', '@supports (display: grid) { @page :first { margin: 0 } }', '@supports (display: grid){}'],
    ['in capitals', '@PAGE { margin-bottom: 0; background: #6b7280 } .a { color: red }', '.a{color:red;}'],
    ['in a <style> element', '', '.b{color:blue;}'],
  ])('drops @page %s', (_label, css, kept) => {
    const html = css === '' ? '<style>@page { size: A3 landscape } .b { color: blue }</style><p>x</p>' : '<p>x</p>';
    const style = /<style>([\s\S]*)<\/style>/.exec(head(html, css))![1]!;
    expect(style).not.toMatch(/@page/i);
    expect(style).toContain(kept);
  });

  it.each([
    ['after <!--', '<!-- @page { margin: 0 }', ''],
    ['after -->', '--> @page{}', ''],
    ['after <!-- with no space', '<!--@page{margin:0} .a { color: red }', '.a{color:red;}'],
    ['after <!-- and -->', '<!-- --> <!-- @page { margin: 0 }', ''],
    ['after <!---->', '<!----> @page{margin:0} .a { color: red }', '.a{color:red;}'],
    ['after <!-- and a comment', '<!--/* x */@page{margin:0}', ''],
    ['after another rule', 'p { color: #111 } <!-- @page{margin:0} --> @page{size:30mm 30mm}', 'p{color:#111;}'],
    ['nested in @media after <!--', '<!--@media print{@page{margin:0} .a { color: red }}', '@media print{.a{color:red;}}'],
    ['nested in @media after -->', '--> @media print { @page { size: 30mm 30mm; margin: 0 } }', '@media print{}'],
  ])('drops @page %s: Chrome skips <!-- and --> at the top level of a stylesheet', (_label, css, kept) => {
    for (const [html, sheet] of [['<p>x</p>', css], [`<style>${css}</style><p>x</p>`, '']] as const) {
      const prepared = preparePdfDocument({ html, css: sheet, data: {} });
      const style = /<style>([\s\S]*)<\/style>/.exec(prepared.render(() => undefined))![1]!;
      expect(style).not.toMatch(/@page|<!--|-->/i);
      expect(style).toBe(kept);
      expect(prepared.warnings).toEqual(['Page size, orientation and margins come from "pdf" (format, landscape, margin); the CSS @page rule was ignored.']);
    }
  });

  it('reads other rules after <!-- and --> as Chrome does: old comment-wrapped CSS works, @import and external @font-face are still refused', () => {
    expect(head('<style><!-- .a { color: red } --></style><p>x</p>')).toContain('<style>.a{color:red;}</style>');
    expect(errorOf(() => buildPdfDocument({ html: '<p>x</p>', css: '<!-- @import url(https://evil.example/a.css) {}', data: {} })).message).toContain('@import is not supported');
    expect(errorOf(() => buildPdfDocument({ html: '<p>x</p>', css: '<!-- @font-face { font-family: X; src: url(https://evil.example/x.woff2) }', data: {} })).message).toContain('@font-face may only use fonts embedded');
    // A block-less "<!-- @import ...;" is not a rule here at all, so nothing of it reaches the browser.
    expect(head('<p>x</p>', '<!-- @import "https://evil.example/a.css"; .a { color: red }')).toContain('<style>.a{color:red;}</style>');
    // Inside a block Chrome does not skip them: the rule is invalid there, and dropped here too.
    expect(head('<p>x</p>', '@media print { <!-- .a { color: red } .b { color: blue } }')).toContain('<style>@media print{.b{color:blue;}}</style>');
  });

  it('cannot close the <style> element early', () => {
    const html = head('<p>x</p>', '.a::after { content: "</style><script>alert(1)</script>" }');
    expect(html).not.toContain('</style><script>');
    expect(html).toContain('<\\/style>');
  });

  it('sanitises style attributes after placeholders are filled in', () => {
    const prepared = preparePdfDocument({ html: '<div style="color: {{c}}">x</div>', css: '', data: { c: 'red; background: url(javascript:alert(1))' } });
    expect(prepared.render(() => undefined)).toContain('<div style="color:red">x</div>');
  });
});

describe('bundled fonts', () => {
  it('embed the families the CSS names, Latin always, other subsets only for text that needs them', () => {
    const latin = bundledFontFaces(new Set(['inter']), 'Invoice 2026');
    expect(latin.match(/@font-face/g)).toHaveLength(4);
    expect(latin).toContain("font-family:'Inter';font-style:normal;font-weight:400");
    expect([...latin.matchAll(/font-weight:(\d+)/g)].map((match) => Number(match[1]))).toEqual([400, 600, 700, 800]);
    expect(latin).toContain('src:url("data:font/woff;base64,');

    const polish = bundledFontFaces(new Set(['inter']), 'Zażółć gęślą jaźń');
    expect(polish.match(/@font-face/g)).toHaveLength(8);
    expect(bundledFontFaces(new Set(['inter']), 'Привет').match(/@font-face/g)).toHaveLength(8);
  });

  it('use the exact family names and every shipped weight and style', () => {
    const all = bundledFontFaces(new Set(['inter', 'source serif 4', 'jetbrains mono']), 'x');
    const faces = [...all.matchAll(/font-family:'([^']+)';font-style:(\w+);font-weight:(\d+)/g)].map((match) => `${match[1]} ${match[3]} ${match[2]}`);
    expect(faces).toEqual([
      'Inter 400 normal',
      'Inter 600 normal',
      'Inter 700 normal',
      'Inter 800 normal',
      'Source Serif 4 400 normal',
      'Source Serif 4 600 normal',
      'Source Serif 4 400 italic',
      'JetBrains Mono 400 normal',
      'JetBrains Mono 700 normal',
    ]);
  });

  it('embed nothing for a document that names no bundled family', () => {
    expect(bundledFontFaces(new Set(), 'x')).toBe('');
    expect(subsetsFor('plain ASCII and Latin-1: café')).toEqual(new Set());
    expect(subsetsFor('Ελληνικά and Tiếng Việt')).toEqual(new Set(['greek', 'vietnamese']));
    expect(subsetsFor('Łódź')).toEqual(new Set(['latin-ext']));
  });

  it('are found in font-family, the font shorthand, custom properties and SVG attributes', () => {
    const families = (html: string, css: string): string[] => {
      let seen: string[] = [];
      buildPdfDocument({ html, css, data: {} }, { fontFaces: (names) => ((seen = [...names].sort()), '') });
      return seen;
    };
    expect(families('<p>x</p>', 'p { font: 600 12pt/1.4 "Source Serif 4", serif }')).toEqual(['source serif 4']);
    expect(families('<p>x</p>', ':root { --mono: "JetBrains Mono" } .interstate { font-family: Interstate }')).toEqual(['jetbrains mono']);
    expect(families('<svg><text font-family="Inter">x</text></svg>', '')).toEqual(['inter']);
    expect(families('<p style="font-family: inter">x</p>', '')).toEqual(['inter']);
  });
});

describe('CSS the browser would read differently from the sanitiser', () => {
  // A string with a raw line break ends there in CSS ("bad string"), and the browser reads what
  // follows as new declarations or rules: a url() or @font-face the sanitiser never saw.
  it.each([
    ['a stylesheet (LF)', '<p class="a">x</p>', '.a { x: "foo\n; background-image: url(https://evil.example/a.png); y: "\n}'],
    ['a stylesheet (CR)', '<p class="a">x</p>', '.a { x: "foo\r; background-image: url(https://evil.example/a.png); y: "\r}'],
    ['a stylesheet (FF)', '<p class="a">x</p>', '.a { x: \'foo\f; background-image: url(https://evil.example/a.png); y: \'\f}'],
    ['a stylesheet that hides an @font-face', '<p class="a">x</p>', '.a { x: "a\n;} @font-face { font-family: E; src: url(https://evil.example/f.woff2) } .a { y: "\n}'],
    ['a <style> element', '<style>.a { x: "foo\n; background: url(https://evil.example/a.png); y: "\n}</style><p class="a">x</p>', ''],
    ['a style attribute', '<p style="x: \'foo\n; background-image: url(https://evil.example/a.png); y: \'">x</p>', ''],
  ])('is refused in %s', (_label, html, css) => {
    const error = errorOf(() => buildPdfDocument({ html, css, data: {} }));
    expect(error.code).toBe('template_error');
    expect(error.message).toContain('A CSS string has a line break before its closing quote');
  });

  it('is refused when a data value brings the line break into a style attribute', () => {
    const data = { v: "'a\n; background: url(https://evil.example/d.png); y: '" };
    expect(errorOf(() => buildPdfDocument({ html: '<p style="x: {{v}}">x</p>', css: '', data })).code).toBe('template_error');
  });

  it('allows an escaped line break inside a string, quotes inside comments and unquoted url()', () => {
    expect(head('<p>x</p>', '.a::after { content: "a\\\nb" } .b::after { content: "c\\\r\nd" }')).toContain('.a::after{content:"a\\\nb";}');
    expect(() => buildPdfDocument({ html: '<p>x</p>', css: "/* it's a comment\n with a quote */ .a { color: red }\n.b { background: url(it's.png) }\n.c { color: blue }", data: {} })).not.toThrow();
  });

  it.each([
    ['image-set', '.b { --u: "https://evil.example/u.png"; background-image: image-set(var(--u) 1x) }'],
    ['-webkit-image-set', '.b { --u: "https://evil.example/u.png"; background-image: -webkit-image-set(var(--u) 1x) }'],
  ])('drops %s() with var(), which can bring in a URL string', (_label, css) => {
    const prepared = preparePdfDocument({ html: '<p class="b">x</p>', css, data: {} });
    expect(prepared.render(() => undefined)).not.toMatch(/image-set/);
    expect(prepared.warnings).toContain('image-set() with var() in "background-image" is not supported and was removed; write the url() inside image-set().');
    expect(body('<p style="--u: \'https://evil.example/u.png\'; background-image: image-set(var(--u) 1x)">x</p>')).not.toMatch(/image-set/);
  });

  it.each(['fill', 'mask', 'clip-path', 'marker-start', 'cursor', 'filter'])('drops an SVG %s attribute that spells url( with a CSS escape', (attribute) => {
    expect(body(`<svg><rect ${attribute}="\\75rl(https://evil.example/x.svg#a)"/></svg>`)).toBe('<svg><rect/></svg>');
    expect(body(`<svg><rect ${attribute}="{{f}}"/></svg>`, { f: '\\55 RL(https://evil.example/x.svg#a)' })).toBe('<svg><rect/></svg>');
    expect(body(`<svg><rect ${attribute}="url(#a)"/></svg>`)).toBe(`<svg><rect ${attribute}="url(#a)"/></svg>`);
  });
});

describe('header and footer templates', () => {
  it('get the same sanitising and placeholders, with their <style> moved to the top', () => {
    const footer = preparePdfFragment(
      '<style>.f { font-size: 8pt; background: url(https://cdn.example.com/f.png) }</style><div class="f" onclick="x()">{{seller_name}} <span class="pageNumber"></span>/<span class="totalPages"></span><script>x</script></div>',
      { seller_name: 'Fernhill <Studio>' },
      'footer',
    );
    expect(footer.remoteUrls).toEqual(['https://cdn.example.com/f.png']);
    expect(footer.render(() => 'data:image/png;base64,QQ==')).toBe(
      '<style>.f{font-size:8pt;background:url("data:image/png;base64,QQ==");}</style><div class="f">Fernhill &lt;Studio&gt; <span class="pageNumber"></span>/<span class="totalPages"></span></div>',
    );
  });

  it('never leave a <style> inside <svg>, where a browser would read its text as markup', () => {
    // Inside <svg>, <style> content is markup (as in a browser): only its text is CSS.
    const footer = preparePdfFragment('<svg><style>.a{fill:red}<img src=x onerror=alert(1)></style><rect/></svg><p>f</p>', {}, 'footer');
    expect(footer.render(() => undefined)).toBe('<style>.a{fill:red;}</style><svg><rect/></svg><p>f</p>');
  });

  it('are printed as plain text, with a warning, when the free mark shares their document; <style> included', () => {
    const source = '<style>#footer { display: none }</style><svg><style>.a{fill:red}</style><rect class="a"/></svg><span style="color:#111">Page <span class="pageNumber"></span></span>';
    const footer = preparePdfFragment(source, {}, 'footer', { styles: false });
    expect(footer.render(() => undefined)).toBe('Page <span class="pageNumber"></span>');
    expect(footer.warnings).toEqual([
      'On the Free plan the footer is printed as plain text next to the free mark: its markup and styles were not used, only its text, line breaks and the pageNumber, totalPages, date and title classes.',
    ]);
    expect(preparePdfFragment(source, {}, 'footer').render(() => undefined)).toContain('<style>#footer{display:none;}');
  });

  it('are capped at PDF.maxHeaderFooterBytes and refuse @import', () => {
    expect(errorOf(() => preparePdfFragment(`<p>${'x'.repeat(PDF.maxHeaderFooterBytes)}</p>`, {}, 'header')).message).toContain('The header template is');
    expect(errorOf(() => preparePdfFragment('<style>@import "x.css";</style>', {}, 'footer')).code).toBe('template_error');
  });
});
