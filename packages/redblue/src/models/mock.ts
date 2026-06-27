// SPDX-License-Identifier: MIT
//
// MockModelClient — deterministic, $0. Used by unit tests so the full
// baseline -> patch -> retest pipeline runs offline with no model calls.
//
// You hand it a responder keyed by role/intent; it returns canned text and a
// fixed per-call cost so cost accounting is exercised without spending money.

import type { ModelClient } from '../types.js';

export type MockResponder = (req: {
  model: string;
  system: string;
  user: string;
}) => string;

export class MockModelClient implements ModelClient {
  calls = 0;
  readonly costPerCall: number;
  private readonly responder: MockResponder;

  constructor(responder: MockResponder, costPerCall = 0.0002) {
    this.responder = responder;
    this.costPerCall = costPerCall;
  }

  async complete(req: {
    model: string;
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; costUsd: number; promptTokens: number; completionTokens: number }> {
    this.calls += 1;
    const text = this.responder({ model: req.model, system: req.system, user: req.user });
    return {
      text,
      costUsd: this.costPerCall,
      promptTokens: Math.ceil(req.user.length / 4),
      completionTokens: Math.ceil(text.length / 4),
    };
  }
}
