/**
 * The tool catalogue: every tool the home page lists, one entry each.
 *
 * scripts/tools-site.ts turns this file into the static grid of the home page at build time
 * (the [[> tool-grid]] and [[> tool-chips]] partials of site/pages/index.html). Nothing here is
 * rendered in the browser; site/public/assets/js/tool-finder.js only hides and shows tiles.
 *
 * TO ADD A TOOL: add one entry to TOOLS. Its place in the list is its place in its column.
 *
 *   id          Unique, lower case with dashes. Printed as data-tool on the tile.
 *   name        The name on the tile. Keep it under about 22 characters.
 *   short       Optional shorter name for phones (two tiles share the width there, under the
 *               column's heading). Leave it out when the name has about 12 characters or fewer.
 *   description One line, no full stop. It must fit one line of a column on a 1366 px wide
 *               screen: stay under about 28 characters. Say what the tool does today, in every
 *               build that publishes it. No numbers about plans, prices or limits.
 *   href        Where the tile goes: the tool's own page ("/tools/merge-pdf"), its docs page when
 *               it has no page ("/docs/api"), or an anchor of the home page ("/#playground").
 *   category    The column: one of TOOL_CATEGORIES' ids.
 *   label       What it costs, from TOOL_LABELS. It must be true:
 *                 "free"    works at no cost without an account;
 *                 "credits" needs an account and uses the images of its plan (the Free plan
 *                           includes a monthly allowance);
 *                 "both"    a free page without an account, plus an API or automated version
 *                           that uses credits.
 *   features    The site features (scripts/build-site.ts FEATURES) that must ALL be published
 *               for the tile to appear; [] for a tool every build has. Use the feature of the
 *               page the tile links to.
 *   keywords    Extra words the search box should find, lower case, space separated. The name,
 *               the short name, the description, the label and the column title are searched
 *               already.
 *   icon        A key of TOOL_ICONS (site/tool-icons.ts). Draw a new pictogram there when none
 *               fits: neutral shapes only, never another company's logo or mark.
 *
 * What the build does with it:
 *   - A tile is printed only when every feature of its entry is on AND the page behind its href
 *     is published as launched in that build. A docs page that the build publishes only with its
 *     "not switched on yet" notice ("apidocs") gets no tile, and neither does a page that is not
 *     built, so a tile can never lead to a missing page or promise a tool that is switched off.
 *   - A column without tiles is not printed, and neither is its filter chip. The counts on the
 *     column headings and the chips are counted from the tiles that were printed.
 *   - tests/node/home-tools.test.ts checks every entry: each page under /tools/ has exactly one
 *     tile, each href resolves, the labels come from TOOL_LABELS.
 */
import type { Feature } from '../scripts/build-site';
import type { ToolIconId } from './tool-icons';

/** The filter chips above the grid, in order. A chip covers every column that names it. */
export const TOOL_CHIPS = [
  { id: 'previews', title: 'Link previews' },
  { id: 'images', title: 'Images' },
  { id: 'pdf', title: 'PDF' },
  { id: 'automation', title: 'Automation' },
] as const;
export type ToolChipId = (typeof TOOL_CHIPS)[number]['id'];

/** The columns of the grid, in order. `chip` is the filter chip that shows the column. */
export const TOOL_CATEGORIES = [
  { id: 'previews', title: 'Link previews', chip: 'previews' },
  { id: 'images', title: 'Images', chip: 'images' },
  { id: 'pdf-files', title: 'PDF · files', chip: 'pdf' },
  { id: 'pdf-docs', title: 'PDF · documents', chip: 'pdf' },
  { id: 'automation', title: 'Automation', chip: 'automation' },
] as const satisfies ReadonlyArray<{ id: string; title: string; chip: ToolChipId }>;
export type ToolCategoryId = (typeof TOOL_CATEGORIES)[number]['id'];

/**
 * The only labels a tile may carry. `text` is printed on wide screens, `short` on phones, where
 * the legend above the grid explains the letters. `free` says whether the "Free only" chip keeps
 * the tile: true when the tool has a page that works at no cost without an account.
 */
export const TOOL_LABELS = {
  free: { text: 'Free', short: 'F', free: true },
  credits: { text: 'Credits', short: 'C', free: false },
  both: { text: 'Free + credits', short: 'F+C', free: true },
} as const;
export type ToolLabelId = keyof typeof TOOL_LABELS;

export interface Tool {
  id: string;
  name: string;
  short?: string;
  description: string;
  href: string;
  category: ToolCategoryId;
  label: ToolLabelId;
  features: readonly Feature[];
  keywords: string;
  icon: ToolIconId;
}

export const TOOLS: readonly Tool[] = [
  // ------------------------------------------------------------ Link previews
  {
    id: 'og-checker',
    name: 'Open Graph checker',
    short: 'OG checker',
    description: 'Check a link for every app',
    href: '/tools/og-checker',
    category: 'previews',
    label: 'free',
    features: [],
    keywords: 'og meta tags og:image facebook imessage twitter share debugger validator unfurl',
    icon: 'inspect',
  },
  {
    id: 'x-card-validator',
    name: 'X card validator',
    description: 'Check your X card tags',
    href: '/tools/x-card-validator',
    category: 'previews',
    label: 'free',
    features: ['previews'],
    keywords: 'twitter card summary_large_image tweet og checker',
    icon: 'card-top',
  },
  {
    id: 'linkedin-post-preview',
    name: 'LinkedIn post preview',
    short: 'LinkedIn post',
    description: 'A link’s look on LinkedIn',
    href: '/tools/linkedin-post-preview',
    category: 'previews',
    label: 'free',
    features: ['previews'],
    keywords: 'link share og checker post inspector',
    icon: 'post',
  },
  {
    id: 'slack-link-preview',
    name: 'Slack link preview',
    short: 'Slack link',
    description: 'A link’s unfurl in Slack',
    href: '/tools/slack-link-preview',
    category: 'previews',
    label: 'free',
    features: ['previews'],
    keywords: 'unfurl message og checker',
    icon: 'unfurl',
  },
  {
    id: 'discord-embed-preview',
    name: 'Discord embed preview',
    short: 'Discord embed',
    description: 'A link’s embed in Discord',
    href: '/tools/discord-embed-preview',
    category: 'previews',
    label: 'free',
    features: ['previews'],
    keywords: 'theme-color link og checker',
    icon: 'embed',
  },
  {
    id: 'whatsapp-link-preview',
    name: 'WhatsApp link preview',
    short: 'WhatsApp link',
    description: 'A link’s look in WhatsApp',
    href: '/tools/whatsapp-link-preview',
    category: 'previews',
    label: 'free',
    features: ['previews'],
    keywords: 'chat message og checker',
    icon: 'bubble',
  },

  // ------------------------------------------------------------ Images
  {
    id: 'card-builder',
    name: 'Share card builder',
    short: 'Card builder',
    description: 'Type a title, see the card',
    href: '/#playground',
    category: 'images',
    label: 'both',
    features: [],
    keywords: 'og image open graph social card playground template html css generator maker twitter',
    icon: 'card-type',
  },
  {
    id: 'link-cards',
    name: 'Cards from links',
    short: 'Link cards',
    description: 'A card from a page’s tags',
    href: '/docs/link-cards',
    category: 'images',
    label: 'credits',
    features: ['linkcards'],
    keywords: 'url og image automatic title description icon api',
    icon: 'link',
  },
  {
    id: 'email-images',
    name: 'Email images',
    description: 'A reader’s name in an image',
    href: '/docs/email-images',
    category: 'images',
    label: 'credits',
    features: ['email'],
    keywords: 'personalized personalised newsletter banner merge tag open field',
    icon: 'envelope',
  },

  // ------------------------------------------------------------ PDF, files
  {
    id: 'merge-pdf',
    name: 'Merge PDF',
    description: 'Join PDFs in your browser',
    href: '/tools/merge-pdf',
    category: 'pdf-files',
    label: 'free',
    features: ['localpdf'],
    keywords: 'combine join files order no upload',
    icon: 'merge',
  },
  {
    id: 'image-to-pdf',
    name: 'Image to PDF',
    description: 'Images into one PDF',
    href: '/tools/image-to-pdf',
    category: 'pdf-files',
    label: 'free',
    features: ['localpdf'],
    keywords: 'jpg jpeg png webp gif photo picture convert no upload browser',
    icon: 'picture',
  },
  {
    id: 'pdf-toolkit',
    name: 'PDF toolkit API',
    description: 'Merge, split, stamp, fill',
    href: '/docs/pdf-tools',
    category: 'pdf-files',
    label: 'credits',
    features: ['toolkit'],
    keywords: 'form fields protect password images pages watermark',
    icon: 'split',
  },

  // ------------------------------------------------------------ PDF, documents
  {
    id: 'html-to-pdf',
    name: 'HTML to PDF',
    description: 'Paste HTML, get a PDF',
    href: '/tools/html-to-pdf',
    category: 'pdf-docs',
    label: 'both',
    features: ['pdf'],
    keywords: 'css convert converter print chrome api',
    icon: 'code',
  },
  {
    id: 'invoice-generator',
    name: 'Invoice generator',
    short: 'Invoices',
    description: 'A PDF invoice from a form',
    href: '/tools/invoice-generator',
    category: 'pdf-docs',
    label: 'both',
    features: ['pdf'],
    keywords: 'bill receipt tax total maker api',
    icon: 'invoice',
  },
  {
    id: 'certificate-generator',
    name: 'Certificate generator',
    short: 'Certificates',
    description: 'A certificate of completion',
    href: '/tools/certificate-generator',
    category: 'pdf-docs',
    label: 'both',
    features: ['pdf'],
    keywords: 'course workshop award diploma maker api',
    icon: 'certificate',
  },
  {
    id: 'bulk-documents',
    name: 'Bulk documents',
    short: 'Bulk PDFs',
    description: 'A PDF per spreadsheet row',
    href: '/docs/bulk',
    category: 'pdf-docs',
    label: 'credits',
    features: ['batch'],
    keywords: 'batch csv sheet rows zip certificates mail merge',
    icon: 'rows',
  },

  // ------------------------------------------------------------ Automation
  {
    id: 'api',
    name: 'API',
    description: 'Render with one request',
    href: '/docs/api',
    category: 'automation',
    label: 'credits',
    features: [],
    keywords: 'rest http post key curl reference developer',
    icon: 'terminal',
  },
  {
    id: 'signed-urls',
    name: 'Signed URLs',
    description: 'One og:image URL per page',
    href: '/docs/signed-urls',
    category: 'automation',
    label: 'credits',
    features: [],
    keywords: 'hmac signature meta tag link secret',
    icon: 'key',
  },
  {
    id: 'workflows',
    name: 'Zapier, Make and n8n',
    short: 'Workflows',
    description: 'The API in a workflow step',
    href: '/docs/integrations',
    category: 'automation',
    label: 'credits',
    features: ['integrations'],
    keywords: 'automation zap scenario node webhook http request connector no-code',
    icon: 'plug',
  },
];
