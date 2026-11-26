/**
 * The PDF toolkit (POST /v1/pdf-tools/{op}): browser-free PDF operations on @cantoo/pdf-lib.
 * Every operation is a pure async function of input bytes and options; storage, charging
 * (pdfToolkitUnits in src/config.ts), fetching inputs and the Free-plan decision are the
 * route's. Client mistakes throw ApiError (src/lib/errors.ts) with a message that says what to fix.
 */
export { assertTotalBytes, fileLabel, loadPdf } from './document';
export { fields, fill, type FieldInfo, type FieldType, type FillOptions, type FillValue } from './forms';
export { fromImages, IMAGE_FITS, IMAGE_ORIENTATIONS, IMAGE_PAGE_SIZES, type FromImagesOptions, type ImageFit, type ImageOrientation, type ImagePageSize } from './from-images';
export { addFreeMark, stampFreeMark } from './mark';
export { merge, type MergeInput } from './merge';
export { parsePageRanges, selectPages, type PageRange } from './pages';
export { PERMISSION_FLAGS, protect, type ProtectOptions, type ProtectPermissions } from './protect';
export { split, type SplitOptions, type SplitOutput, type SplitResult } from './split';
export { stamp, STAMP_DEFAULTS, STAMP_POSITIONS, type ImageStamp, type StampOptions, type StampPosition, type TextStamp } from './stamp';
export { STAMP_FONTS, type StampFont } from './text';
export type { OutputOptions, PdfOutput } from './types';
export { isToolkitOp, parseToolkitRequest, runToolkitOp, type FileRef, type ToolkitRequest, type ToolkitResponseMode, type ToolkitResult } from './request';
export { estimateStructure, MAX_STRUCTURE_TOKENS, type StructureEstimate } from './budget';
