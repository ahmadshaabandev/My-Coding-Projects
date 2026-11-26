// /tools/merge-pdf: several PDFs into one, in the order of the list, in this browser.
// The list, limits and download are local-files.js; the PDF work is the engine's
// (./vendor/pdf-local.js, mergePdfs). Nothing is uploaded.
import { formatSize, plural, setupFileTool, totalSize } from './local-files.js';

/** "3 PDFs, 12 pages, 2.4 MB together." */
export function mergeSummary(items) {
  const pages = items.reduce((sum, item) => sum + item.pages, 0);
  return `${plural(items.length, 'PDF')}, ${plural(pages, 'page')}, ${formatSize(totalSize(items))} together.`;
}

export const MERGE_TOOL = {
  noun: 'PDF',
  minFiles: 2,
  outputName: 'merged.pdf',
  async prepare(file, bytes, engine, limits) {
    const { pages } = await engine.readPdf({ name: file.name, bytes }, { maxPages: limits.maxPages });
    return { bytes, pages, detail: plural(pages, 'page') };
  },
  run(items, engine, limits) {
    return engine.mergePdfs(
      items.map(({ name, bytes }) => ({ name, bytes })),
      { maxPages: limits.maxPages },
    );
  },
  summary: mergeSummary,
  working: (items) => `Merging ${plural(items.length, 'PDF')}…`,
};

if (typeof document !== 'undefined') setupFileTool(MERGE_TOOL);
