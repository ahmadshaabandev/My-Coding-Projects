/**
 * Text drawing for stamps, form values and the free mark. The toolkit uses the 14 standard PDF
 * fonts only: every reader has them, nothing is embedded, and pdf-lib needs no font parser
 * (fontkit) for them. Their encoding is WinAnsi (Windows-1252), so text in other scripts
 * (Arabic, Cyrillic, CJK, emoji...) cannot be drawn; it is refused with a message that names the
 * first character, instead of pdf-lib's internal error.
 */
import { type PDFDocument, type PDFFont, type RGB, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { ApiError } from '../lib/errors';

export const STAMP_FONTS = {
  helvetica: StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  'times-bold': StandardFonts.TimesRomanBold,
  courier: StandardFonts.Courier,
  'courier-bold': StandardFonts.CourierBold,
} as const;
export type StampFont = keyof typeof STAMP_FONTS;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** "#rgb" or "#rrggbb" to pdf-lib's colour. */
export function parseColor(value: string, what: string): RGB {
  const match = HEX.exec(value.trim());
  if (!match) throw new ApiError('invalid_request', `${what} must be a hex colour like "#dc2626" or "#f00".`);
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join('') : match[1]!;
  const channel = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
  return rgb(channel(0), channel(2), channel(4));
}

/** One standard font per document and name: embedding twice would write two font objects. */
export async function standardFont(doc: PDFDocument, name: StandardFonts, cache: Map<StandardFonts, PDFFont>): Promise<PDFFont> {
  let font = cache.get(name);
  if (!font) {
    font = await doc.embedFont(name);
    cache.set(name, font);
  }
  return font;
}

/** Throws unless every character of `text` exists in `font` (WinAnsi for the standard fonts). */
export function assertDrawable(font: PDFFont, text: string, what: string): void {
  const supported = new Set(font.getCharacterSet());
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x0a || code === 0x0d || code === 0x09) {
      throw new ApiError('invalid_request', `${what} must be a single line (no line breaks or tabs).`);
    }
    if (!supported.has(code)) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0');
      throw new ApiError(
        'invalid_request',
        `${what} contains "${char}" (U+${hex}), which the standard PDF fonts cannot show. Only Latin characters (Windows-1252) are supported.`,
        { details: { character: char, code_point: `U+${hex}` } },
      );
    }
  }
}
