// SPDX-License-Identifier: MIT
//
// @metaharness/projects — minimal OpenRouter client (optional, real-LLM tool).
// Used ONLY by opt-in real benchmarks (e.g. the typed-handoff A/B), never by the
// deterministic suite. Mirrors the Semgrep/fuzz "real tool" pattern: it is OPTIONAL
// (absent key ⇒ unavailable ⇒ callers skip) so the reproducible suite stays green
// and free. Dependency-free (Node 20+ global fetch). The API key is read from the
// environment and NEVER logged. A hard request cap bounds spend by construction.

/** The key, from the environment. Never logged or returned in receipts. */
export function openRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY || undefined;
}

/** True when a key is present (callers skip the real bench otherwise). */
export function openRouterAvailable(): boolean {
  return !!openRouterKey();
}

/** Canonical lane models (ADR-167). The frontier lane is empirically selected:
 *  Qwen3-235B-A22B won the bake-off on verified-per-cost (6/6, ~0.019 mUSD/verified),
 *  beating GLM-5.2 (5/6, ~0.91) — and it is also cheap. Override via env in benches. */
export const DEFAULT_CHEAP_MODEL = 'qwen/qwen-2.5-7b-instruct';
export const DEFAULT_FRONTIER_MODEL = 'qwen/qwen3-235b-a22b-2507';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatJSONResult {
  raw: string;
  parsed: unknown | null;
  promptTokens: number;
  completionTokens: number;
}

export interface OpenRouterOptions {
  model?: string;
  apiKey?: string;
  /** Hard cap on total requests for this client instance (budget guard). */
  maxRequests?: number;
  temperature?: number;
  timeoutMs?: number;
  baseUrl?: string;
  /** Inject a custom fetch (for deterministic testing). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** A small, budget-guarded OpenRouter chat client. */
export class OpenRouterClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly maxRequests: number;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private requests = 0;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(opts: OpenRouterOptions = {}) {
    this.apiKey = opts.apiKey ?? openRouterKey() ?? '';
    this.model = opts.model ?? process.env.LLM_MODEL ?? 'openai/gpt-4o-mini';
    this.maxRequests = opts.maxRequests ?? 100;
    this.temperature = opts.temperature ?? 0;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  stats(): { requests: number; promptTokens: number; completionTokens: number } {
    return { requests: this.requests, promptTokens: this.promptTokens, completionTokens: this.completionTokens };
  }

  /**
   * One chat completion; returns the raw content and a best-effort JSON parse
   * (parsed=null if the model did not emit valid JSON). Enforces the request cap.
   */
  async chatJSON(messages: ChatMessage[], opts: { maxTokens?: number } = {}): Promise<ChatJSONResult> {
    if (!this.apiKey) throw new Error('OpenRouter key absent (set OPENROUTER_API_KEY)');
    if (this.requests >= this.maxRequests) throw new Error(`OpenRouter request cap reached (${this.maxRequests})`);
    this.requests += 1;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/ruvnet/agent-harness-generator',
          'X-Title': 'metaharness-projects',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: opts.maxTokens ?? 256,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? '';
    this.promptTokens += json.usage?.prompt_tokens ?? 0;
    this.completionTokens += json.usage?.completion_tokens ?? 0;
    return { raw, parsed: tryParseJson(raw), promptTokens: json.usage?.prompt_tokens ?? 0, completionTokens: json.usage?.completion_tokens ?? 0 };
  }
}

/** Best-effort JSON parse: tolerates ```json fences and surrounding prose. */
export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to the first {...} or [...] block.
    const m = trimmed.match(/[{[][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}
