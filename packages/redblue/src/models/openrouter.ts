// SPDX-License-Identifier: MIT
//
// OpenRouter-backed ModelClient. Real calls; no fabrication. The runner wires
// a hard spend cap around this (limits.max_cost_usd) and gates on the presence
// of OPENROUTER_API_KEY before ever making a live call.
//
// Mirrors the call pattern used by darwin-mode's openrouter-mutator.

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient } from '../types.js';

function apiKey(): string {
  const env = (process.env.OPENROUTER_API_KEY || '').trim();
  if (env) return env;
  const keyFile = join(tmpdir(), '.orkey');
  try {
    return readFileSync(keyFile, 'utf8').trim();
  } catch {
    throw new Error(`OpenRouterClient: no OPENROUTER_API_KEY (env or ${keyFile})`);
  }
}

/** True if a real engagement can run (auth/key present). */
export function hasApiKey(): boolean {
  if ((process.env.OPENROUTER_API_KEY || '').trim()) return true;
  try {
    return readFileSync(join(tmpdir(), '.orkey'), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export class OpenRouterClient implements ModelClient {
  async complete(req: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; costUsd: number; promptTokens: number; completionTokens: number }> {
    let res: Response;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens ?? 800,
          temperature: req.temperature ?? 0.7,
        }),
      });
    } catch (e) {
      return { text: '', costUsd: 0, promptTokens: 0, completionTokens: 0 };
    }
    const j: any = await res.json();
    const text: string = j?.choices?.[0]?.message?.content ?? '';
    const usage = j?.usage ?? {};
    return {
      text,
      costUsd: typeof usage.cost === 'number' ? usage.cost : 0,
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    };
  }
}
