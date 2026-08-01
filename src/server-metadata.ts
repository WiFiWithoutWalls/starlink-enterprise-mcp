/**
 * Server identity presented during MCP initialization.
 *
 * MCP 2025-11-25 widened `Implementation` beyond name/version: `title` and
 * `icons` (SEP-973) give clients something to render in a connector list, and
 * `description` aligns with the registry's server.json format. `instructions`
 * has been part of the initialize result since 2024-11-05 but was never set
 * here, so clients had no guidance on how this particular API behaves.
 */

import type { Icon, Implementation } from '@modelcontextprotocol/sdk/types.js';

/** Public docs for the underlying API, shown by clients that surface websiteUrl. */
const DEFAULT_WEBSITE_URL = 'https://starlink.readme.io/';

const SERVER_DESCRIPTION =
  'Manage a Starlink Enterprise account: service lines, user terminals, routers, ' +
  'addresses, contacts, data pools, and usage reporting.';

/**
 * Guidance handed to the model at initialize time. Kept short and specific to
 * the things that actually trip an agent up on this API.
 */
const INSTRUCTIONS = `This server exposes the Starlink Enterprise v2 API.

Conventions that matter here:
- Service lines are addressed by their service line number (e.g. SL-1234567-89012-34),
  user terminals by device ID, and routers by router ID. Call the corresponding
  list tool first when you only have a nickname or address.
- Results are returned as structuredContent shaped like the Starlink response
  envelope: the payload is under "content", and "isValid" reports whether the
  request was accepted.
- Tools whose names start with get_/list_ are read-only. delete_* and *reboot*
  tools affect live customer connectivity — confirm with the user before calling them.
- Permissions are enforced upstream by the service account's role. A permission
  failure comes back as a tool error, not a missing tool.`;

/** Icons advertised for the server and its tools, from MCP_ICON_URL. */
export function serverIcons(): Icon[] | undefined {
  const src = process.env.MCP_ICON_URL;
  if (!src) return undefined;
  const icon: Icon = { src, sizes: ['any'] };
  const mimeType = guessIconMimeType(src);
  if (mimeType) icon.mimeType = mimeType;
  return [icon];
}

function guessIconMimeType(src: string): string | undefined {
  const dataUri = /^data:([^;,]+)/.exec(src);
  if (dataUri) return dataUri[1];
  const ext = /\.(png|jpe?g|svg|webp|gif|ico)(?:\?|#|$)/i.exec(src)?.[1]?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'ico':
      return 'image/x-icon';
    default:
      return undefined;
  }
}

/** Builds the `Implementation` block sent in the initialize result. */
export function buildImplementation(name: string, version: string): Implementation {
  const implementation: Implementation = {
    name,
    title: 'Starlink Enterprise',
    version,
    description: SERVER_DESCRIPTION,
    websiteUrl: process.env.MCP_WEBSITE_URL || DEFAULT_WEBSITE_URL,
  };
  const icons = serverIcons();
  if (icons) implementation.icons = icons;
  return implementation;
}

export function serverInstructions(): string {
  return INSTRUCTIONS;
}
