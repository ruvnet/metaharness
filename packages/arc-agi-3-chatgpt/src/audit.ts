// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent, AuditSink } from './types.js';

export function opaqueAuditHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export class FileAuditSink implements AuditSink {
  constructor(readonly path = process.env.ARC_MCP_AUDIT_LOG ?? '.harness/arc-mcp-audit.jsonl') {}

  async write(event: AuditEvent): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (directory !== '.') await chmod(directory, 0o700);
    await appendFile(this.path, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }
}

export class MemoryAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];

  write(event: AuditEvent): void {
    this.events.push(structuredClone(event));
  }
}
