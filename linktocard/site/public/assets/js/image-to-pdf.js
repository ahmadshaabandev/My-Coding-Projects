// /tools/image-to-pdf: images into one PDF, one image per page, in this browser.
// PNG and JPEG go to the engine as they are (./vendor/pdf-local.js, imagesToPdf); WebP and GIF
// are first drawn on a canvas and saved as PNG here, because pdf-lib embeds only PNG and JPEG.
// The list, limits and download are local-files.js. Nothing is uploaded.
import { formatSize, plural, refusal, setupFileTool, totalSize } from './local-files.js';

/** The page asks for millimetres; the engine, like the API, takes points. */
const MM_TO_POINTS = 72 / 25.4;
const KIND_LABEL = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF' };

/** "4 images, 3.1 MB together." */
export function imageSummary(items) {
  return `${plural(items.length, 'image')}, ${formatSize(totalSize(items))} together.`;
}

/** "1200 x 800 px, JPEG", "640 x 480 px, WebP made PNG"; width and height as shown (EXIF applied). */
export function imageDetail(header, converted) {
  const sideways = header.orientation >= 5;
  const width = sideways ? header.height : header.width;
  const height = sideways ? header.width : header.height;
  return `${width} x ${height} px, ${KIND_LABEL[header.kind]}${converted ? ' made PNG' : ''}`;
}

/**
 * The engine's options from the form: page size, orientation, fit and margin (millimetres on
 * the page, points for the engine). An empty or broken margin counts as 0.
 */
export function imageOptions(values, limits) {
  const margin = Number(String(values.margin ?? '').replace(',', '.'));
  return {
    pageSize: values.page_size,
    orientation: values.orientation,
    fit: values.fit,
    margin: Number.isFinite(margin) && margin > 0 ? margin * MM_TO_POINTS : 0,
    maxImagePixels: limits.maxImagePixels,
  };
}

/** A WebP or GIF (its first frame) as PNG bytes, drawn by the browser's own decoder. */
async function toPng(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((made) => (made ? resolve(made) : reject(new Error('toBlob failed'))), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export const IMAGE_TOOL = {
  noun: 'image',
  minFiles: 1,
  outputName: 'images.pdf',
  async prepare(file, bytes, engine, limits) {
    const header = engine.checkImage({ name: file.name, bytes }, limits);
    let png = null;
    if (header.kind === 'webp' || header.kind === 'gif') {
      try {
        png = await toPng(file);
      } catch {
        throw refusal(`“${file.name}” could not be decoded by this browser.`);
      }
    }
    return { bytes: png ?? bytes, detail: imageDetail(header, png !== null), thumb: URL.createObjectURL(file) };
  },
  run(items, engine, limits, form) {
    const values = Object.fromEntries(['page_size', 'orientation', 'fit', 'margin'].map((name) => [name, form.elements[name]?.value]));
    return engine.imagesToPdf(
      items.map(({ name, bytes }) => ({ name, bytes })),
      imageOptions(values, limits),
    );
  },
  summary: imageSummary,
  working: (items) => `Making a PDF of ${plural(items.length, 'image')}…`,
};

/** Orientation and margin mean nothing for some choices; say so by switching them off. */
function syncOptions(form) {
  const auto = form.elements.page_size.value === 'auto';
  form.elements.orientation.disabled = auto;
  form.elements.margin.disabled = auto || form.elements.fit.value === 'fill';
}

if (typeof document !== 'undefined') {
  const tool = setupFileTool(IMAGE_TOOL);
  if (tool) {
    tool.form.addEventListener('change', () => syncOptions(tool.form));
    syncOptions(tool.form);
  }
}
