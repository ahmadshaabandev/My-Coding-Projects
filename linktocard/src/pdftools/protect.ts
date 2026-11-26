/**
 * protect: password protection with AES-256 (security handler revision 6), pdf-lib's default
 * and, in its own documentation, the only cipher ISO 32000-2 recommends. Weaker ciphers (RC4,
 * AES-128) are never offered.
 *
 *   user_password    needed to open the file; without one the file opens freely and only the
 *                    permissions apply
 *   owner_password   lifts the permissions; required whenever a permission is restricted,
 *                    because a reader that knows the owner password may do everything
 *   permissions      printing: "high" (default), "low" or "none"; modifying, copying, annotating,
 *                    filling_forms, content_accessibility, document_assembly: true (default) or false
 *
 * Permissions are honoured by the PDF reader, not enforced by the encryption: a reader that
 * ignores them can still print or copy from a file it can open. The password to open is real
 * encryption.
 *
 * Passwords are printable ASCII, 1 to 127 characters. Revision 6 uses at most 127 bytes of a
 * password (longer ones would be cut silently), and pdf-lib does not apply the SASLprep step
 * readers use for other characters, so a non-ASCII password might not open the file elsewhere.
 */
import { ApiError } from '../lib/errors';
import { assertTotalBytes, fileLabel, loadPdf, savePdf } from './document';
import { stampFreeMark } from './mark';
import type { OutputOptions, PdfOutput } from './types';

export interface ProtectPermissions {
  printing?: 'high' | 'low' | 'none';
  modifying?: boolean;
  copying?: boolean;
  annotating?: boolean;
  fillingForms?: boolean;
  contentAccessibility?: boolean;
  documentAssembly?: boolean;
}

export interface ProtectOptions extends OutputOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: ProtectPermissions;
}

/** API names of the yes/no permissions (snake_case, as the request body writes them). */
export const PERMISSION_FLAGS = {
  modifying: 'modifying',
  copying: 'copying',
  annotating: 'annotating',
  fillingForms: 'filling_forms',
  contentAccessibility: 'content_accessibility',
  documentAssembly: 'document_assembly',
} as const;

const PASSWORD = /^[\x20-\x7e]{1,127}$/;

function invalid(message: string): ApiError {
  return new ApiError('invalid_request', message);
}

function password(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !PASSWORD.test(value)) {
    throw invalid(`${what} must be 1 to 127 printable ASCII characters (letters, digits, spaces and punctuation).`);
  }
  return value;
}

export async function protect(pdf: Uint8Array, options: ProtectOptions): Promise<PdfOutput> {
  const userPassword = password(options.userPassword, 'user_password');
  const ownerPassword = password(options.ownerPassword, 'owner_password');
  const input = options.permissions ?? {};
  const printing = input.printing ?? 'high';
  if (!['high', 'low', 'none'].includes(printing)) throw invalid('permissions.printing must be "high", "low" or "none".');
  const flags = {} as Record<keyof typeof PERMISSION_FLAGS, boolean>;
  for (const [key, name] of Object.entries(PERMISSION_FLAGS) as [keyof typeof PERMISSION_FLAGS, string][]) {
    const value = input[key] ?? true;
    if (typeof value !== 'boolean') throw invalid(`permissions.${name} must be true or false.`);
    flags[key] = value;
  }
  const restricted = printing !== 'high' || Object.values(flags).includes(false);

  if (userPassword === undefined && ownerPassword === undefined) throw invalid('Give a user_password (to open the file), an owner_password with restricted permissions, or both.');
  if (restricted && ownerPassword === undefined) {
    throw invalid('Restricted permissions need an owner_password: without one, anyone who can open the file could lift them.');
  }
  if (restricted && ownerPassword === userPassword) throw invalid('owner_password must differ from user_password, or the permissions would not restrict anyone.');
  if (!restricted && userPassword === undefined) throw invalid('With every permission allowed and no user_password the file would open and work as before. Set a user_password or restrict a permission.');

  assertTotalBytes([pdf]);
  const doc = await loadPdf(pdf, fileLabel(0));
  // The mark is drawn before encrypt(), so it is part of the encrypted content like everything else.
  if (options.freeMark === true) await stampFreeMark(doc);
  doc.encrypt({
    algorithm: 'AES-256',
    userPassword,
    ownerPassword,
    permissions: {
      printing: printing === 'high' ? 'highResolution' : printing === 'low' ? 'lowResolution' : false,
      ...flags,
    },
  });
  return savePdf(doc);
}
