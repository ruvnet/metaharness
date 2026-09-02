// SPDX-License-Identifier: MIT

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { ARC_WIDGET_URI } from './tools.js';

export { RESOURCE_MIME_TYPE };

export async function loadWidgetHtml(): Promise<string> {
  const path = fileURLToPath(new URL('../public/arc-widget.html', import.meta.url));
  return readFile(path, 'utf8');
}

export function registerArcWidgetResource(server: McpServer, html: string): void {
  registerAppResource(
    server,
    'Exact ARC canvas',
    ARC_WIDGET_URI,
    {
      description: 'Pixel-exact view of the authoritative visible ARC frame.',
      _meta: {
        ui: {
          csp: {
            connectDomains: [],
            resourceDomains: [],
            frameDomains: [],
            baseUriDomains: [],
          },
          prefersBorder: true,
        },
      },
    },
    async () => ({
      contents: [{
        uri: ARC_WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: html,
      }],
    }),
  );
}
