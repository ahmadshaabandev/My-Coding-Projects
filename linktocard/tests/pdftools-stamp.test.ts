// stamp, the free mark and the upright page frame (src/pdftools/stamp.ts, mark.ts, frame.ts).
// Placement is checked on the operators the page ends up with: the frame's "cm" for turned and
// cropped pages, and the text matrix (Tm) of the stamp inside it.
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import { describe, expect, it } from 'vitest';
import { PDF } from '../src/config';
import { addFreeMark, stamp } from '../src/pdftools';
import { toPageSpace, visualFrame } from '../src/pdftools/frame';
import { expectApiError, fixture, hexText, makePdf, pageContent, reload } from './pdftools-helpers';

const MM = 72 / 25.4;
/** -0 to 0, so matrices compare as written. */
const z = (n: number): number => n + 0;

/** The operands of the last "Tm" in a content string. */
function lastTm(content: string): [number, number, number, number, number, number] {
  const all = [...content.matchAll(/(-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) (-?[\d.e-]+) Tm/g)];
  expect(all.length).toBeGreaterThan(0);
  const [a, b, c, d, e, f] = all.at(-1)!.slice(1).map(Number) as [number, number, number, number, number, number];
  return [a, b, c, d, e, f];
}

async function metrics(font: StandardFonts, text: string, size: number) {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(font);
  const ascent = f.heightAtSize(size, { descender: false });
  return { width: f.widthOfTextAtSize(text, size), ascent, descent: ascent - f.heightAtSize(size) };
}

describe('visualFrame', () => {
  it('gives each turned page its upright size and the matrix to page space', async () => {
    const doc = await PDFDocument.load(fixture('rotated.pdf'));
    const frames = doc.getPages().map(visualFrame);
    expect(frames.map((f) => [f.rotation, f.width, f.height])).toEqual([
      [0, 595.28, 841.89],
      [90, 841.89, 595.28],
      [180, 595.28, 841.89],
      [270, 841.89, 595.28],
      [0, 400, 500],
    ]);
    // The upright frame's bottom-left corner is the page corner a reader shows bottom-left:
    // turned 90 clockwise, that is the page's bottom-right (x = width, y = 0); at 180 its
    // top-right; at 270 its top-left. Upright "up" (0, 1) follows the turn the same way.
    const corner = frames.map((f) => toPageSpace(f, 0, 0));
    expect(corner).toEqual([
      { x: 0, y: 0 },
      { x: 595.28, y: 0 },
      { x: 595.28, y: 841.89 },
      { x: 0, y: 841.89 },
      { x: 50, y: 100 },
    ]);
    const up = frames.map((f) => {
      const a = toPageSpace(f, 0, 0);
      const b = toPageSpace(f, 0, 1);
      return { x: z(b.x - a.x), y: z(b.y - a.y) };
    });
    expect(up).toEqual([
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]);
    // The far corner of the frame is the far corner of the visible box.
    expect(toPageSpace(frames[4]!, 400, 500)).toEqual({ x: 450, y: 600 });
  });

  it('treats a crop box outside the media box as absent', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 300]);
    page.setCropBox(500, 500, 10, 10);
    expect(visualFrame(page)).toMatchObject({ width: 200, height: 300, matrix: [1, 0, 0, 1, 0, 0] });
  });
});

describe('free mark', () => {
  it('draws "Made with Link To Card" centred at the bottom of every page as shown', async () => {
    const out = await addFreeMark(fixture('rotated.pdf'));
    expect(out.pages).toBe(5);
    const doc = await reload(out.bytes);
    const cms = ['1 0 0 1 0 0 cm', '0 1 -1 0 595.28 0 cm', '-1 0 0 -1 595.28 841.89 cm', '0 -1 1 0 0 841.89 cm', '1 0 0 1 50 100 cm'];
    const frames = [595.28, 841.89, 595.28, 841.89, 400];
    const { width, descent } = await metrics(StandardFonts.Helvetica, PDF.freeMark, 7.5);
    for (let i = 0; i < 5; i++) {
      const content = pageContent(doc, i);
      expect(content).toContain(hexText(PDF.freeMark));
      expect(content).toContain(`/Artifact BMC\nq\n${cms[i]}`);
      const [, , , , x, y] = lastTm(content);
      expect(x).toBeCloseTo((frames[i]! - width) / 2, 3);
      expect(y).toBeCloseTo(4 * MM + 0.4 * MM - descent, 3);
    }
  });

  it('shrinks the line on a page narrower than it, never clipping it', async () => {
    const out = await addFreeMark(await makePdf(1, { size: [80, 40] }));
    const content = pageContent(await reload(out.bytes), 0);
    const before = content.slice(0, content.indexOf(hexText(PDF.freeMark)));
    const size = Number([...before.matchAll(/ ([\d.]+) Tf/g)].at(-1)?.[1]);
    expect(size).toBeLessThan(7.5);
    const { width } = await metrics(StandardFonts.Helvetica, PDF.freeMark, size);
    expect(width).toBeLessThanOrEqual(80 - 4 * MM + 1e-6);
  });
});

describe('text stamp', () => {
  it('stamps every page by default, faint grey and centred', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { text: { text: 'DRAFT' } });
    expect(out.pages).toBe(8);
    const doc = await reload(out.bytes);
    const { width, ascent, descent } = await metrics(StandardFonts.HelveticaBold, 'DRAFT', 48);
    for (let i = 0; i < 8; i++) {
      const content = pageContent(doc, i);
      expect(content).toContain(hexText('DRAFT'));
      const [a, b, c, d, x, y] = lastTm(content);
      expect([a, b, c, d].map(z)).toEqual([1, 0, 0, 1]);
      expect(x + width / 2).toBeCloseTo(595.28 / 2, 3);
      expect(y + (ascent + descent) / 2).toBeCloseTo(841.89 / 2, 3);
    }
    // Opacity 0.35 through an ExtGState.
    expect(new TextDecoder('latin1').decode(out.bytes)).toMatch(/\/ca 0\.35/);
  });

  it('stamps only the chosen pages', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { text: { text: 'PAID', pages: '2,4-5' } });
    const doc = await reload(out.bytes);
    const stamped = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => pageContent(doc, i).includes(hexText('PAID')));
    expect(stamped).toEqual([1, 3, 4]);
  });

  it('keeps a turned stamp inside the margins in a corner', async () => {
    const rotation = 30;
    const out = await stamp(fixture('multi-page.pdf'), { text: { text: 'PAID', position: 'top-right', rotation, margin: 20, fontSize: 60, font: 'times-bold' } });
    const content = pageContent(await reload(out.bytes), 0);
    const [a, b, c, d, x, y] = lastTm(content);
    const theta = (rotation * Math.PI) / 180;
    expect([a, b, c, d].map((n) => Number(n.toFixed(6)))).toEqual([Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta)].map((n) => Number(n.toFixed(6))));
    const { width, ascent, descent } = await metrics(StandardFonts.TimesRomanBold, 'PAID', 60);
    const corners = ([
      [0, descent],
      [width, descent],
      [width, ascent],
      [0, ascent],
    ] as const).map(([u, v]) => ({ x: a * u + c * v + x, y: b * u + d * v + y }));
    const right = Math.max(...corners.map((p) => p.x));
    const top = Math.max(...corners.map((p) => p.y));
    expect(right).toBeCloseTo(595.28 - 20, 3);
    expect(top).toBeCloseTo(841.89 - 20, 3);
  });

  it('draws upright on turned pages', async () => {
    const out = await stamp(fixture('rotated.pdf'), { text: { text: 'PAID', position: 'bottom-left' } });
    const doc = await reload(out.bytes);
    expect(pageContent(doc, 1)).toContain('/Artifact BMC\nq\n0 1 -1 0 595.28 0 cm');
    const [, , , , x] = lastTm(pageContent(doc, 1));
    expect(x).toBeCloseTo(36, 3);
  });

  it('adds the free mark when asked, in the same pass', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { text: { text: 'PAID' }, freeMark: true });
    const content = pageContent(await reload(out.bytes), 7);
    expect(content).toContain(hexText('PAID'));
    expect(content).toContain(hexText(PDF.freeMark));
  });

  it('refuses text the standard fonts cannot draw, and bad options, by name', async () => {
    const pdf = fixture('multi-page.pdf');
    const arabic = await expectApiError(stamp(pdf, { text: { text: 'مدفوع' } }), 'invalid_request', /text\.text contains "م" \(U\+0645\).*Latin characters \(Windows-1252\)/);
    expect(arabic.details).toEqual({ character: 'م', code_point: 'U+0645' });
    await expectApiError(stamp(pdf, { text: { text: 'two\nlines' } }), 'invalid_request', /single line/);
    await expectApiError(stamp(pdf, { text: { text: '  ' } }), 'invalid_request', /non-empty/);
    await expectApiError(stamp(pdf, { text: { text: 'x'.repeat(PDF.maxDataValueChars + 1) } }), 'invalid_request', /at most 2000 characters/);
    await expectApiError(stamp(pdf, { text: { text: 'x', font: 'comic' as never } }), 'invalid_request', /text\.font must be one of: helvetica/);
    await expectApiError(stamp(pdf, { text: { text: 'x', color: 'red' } }), 'invalid_request', /text\.color must be a hex colour/);
    await expectApiError(stamp(pdf, { text: { text: 'x', opacity: 1.5 } }), 'invalid_request', /text\.opacity must be a number from 0 to 1/);
    await expectApiError(stamp(pdf, { text: { text: 'x', rotation: 400 } }), 'invalid_request', /text\.rotation/);
    await expectApiError(stamp(pdf, { text: { text: 'x', fontSize: 0 } }), 'invalid_request', /text\.font_size/);
    await expectApiError(stamp(pdf, { text: { text: 'x', margin: -1 } }), 'invalid_request', /text\.margin/);
    await expectApiError(stamp(pdf, { text: { text: 'x', position: 'middle' as never } }), 'invalid_request', /text\.position must be one of/);
    await expectApiError(stamp(pdf, { text: { text: 'x', pages: '9' } }), 'invalid_request', /^text\.pages: "9" names page 9/);
    await expectApiError(stamp(pdf, {} as never), 'invalid_request', /either "text" or "image"/);
    await expectApiError(stamp(pdf, { text: { text: 'x' }, image: { image: fixture('logo.png') } } as never), 'invalid_request', /not both/);
  });
});

describe('image stamp', () => {
  it('places a PNG at its natural size, inside the margins', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { image: { image: fixture('logo.png'), position: 'bottom-left' } });
    const content = pageContent(await reload(out.bytes), 0);
    // Centre of a 120 x 40 image 36 pt from the bottom-left corner, then the image's unit square.
    expect(content).toContain('1 0 0 1 96 56 cm');
    expect(content).toContain('120 0 0 40 -60 -20 cm');
    expect(content).toMatch(/\/Image-\d+ Do/);
  });

  it('scales to a given width and turns around its centre', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { image: { image: fixture('photo.jpg'), width: 150, rotation: 90, opacity: 0.5 } });
    const content = pageContent(await reload(out.bytes), 0);
    expect(content).toContain(`1 0 0 1 ${595.28 / 2} ${841.89 / 2} cm`);
    expect(content).toContain('150 0 0 100 -75 -50 cm');
    expect(content).toContain('0 1 -1 0 0 0 cm');
  });

  it('shrinks a large image to fit the page', async () => {
    const out = await stamp(await makePdf(1, { size: [100, 100] }), { image: { image: fixture('photo.jpg'), margin: 10 } });
    const content = pageContent(await reload(out.bytes), 0);
    // 300 x 200 into 80 x 80: scale 80/300.
    expect(content).toContain(`${80} 0 0 ${(200 * 80) / 300} -40 ${-(200 * 80) / 300 / 2} cm`);
  });

  it('shows a JPEG in its EXIF orientation', async () => {
    const out = await stamp(fixture('multi-page.pdf'), { image: { image: fixture('photo-exif-6.jpg') } });
    const content = pageContent(await reload(out.bytes), 0);
    // Shown 100 x 200 (stored 200 x 100), drawn through orientation 6's matrix.
    expect(content).toContain('100 0 0 200 -50 -100 cm');
    expect(content).toContain('0 -1 1 0 0 1 cm');
  });

  it('refuses what is not a PNG or JPEG', async () => {
    await expectApiError(stamp(fixture('multi-page.pdf'), { image: { image: fixture('multi-page.pdf') } }), 'unsupported_media_type', /^image is not a PNG or JPEG/);
    await expectApiError(stamp(fixture('multi-page.pdf'), { image: { image: 'x' as never } }), 'invalid_request', /must be a PNG or JPEG/);
    await expectApiError(stamp(fixture('multi-page.pdf'), { image: { image: fixture('logo.png'), width: -3 } }), 'invalid_request', /image\.width/);
  });
});
