// Tests for the real-LLM ModelDriver (LlmDriver) and its deterministic mock
// completion seam. These prove that a LIVE model — anything answering the
// injected (prompt) => Promise<string> seam — can drive the same code-as-action
// loop the ScriptedDriver drives, without a network and without nondeterminism.
//
// The whole suite is deterministic: MockCompletion maps call-count to canned
// completions, so there is no clock, no randomness, no I/O beyond the wasm VM.
import { describe as suite, expect, it } from 'vitest';
import {
  Agent,
  agentic,
  Runtime,
  CellVm,
  LlmDriver,
  MockCompletion,
  extractCode,
  CELL_INSTRUCTION,
} from '../src/index.js';

// ---------------------------------------------------------------- fixtures --

interface Order {
  id: string;
  delivered: boolean;
  daysSinceDelivery: number;
}

class SupportAgent extends Agent {
  static doc = 'You are a support agent.';

  orders: Record<string, Order> = {
    'A-1': { id: 'A-1', delivered: true, daysSinceDelivery: 12 },
    'A-2': { id: 'A-2', delivered: true, daysSinceDelivery: 45 },
  };

  isRefundEligible(orderId: string): boolean {
    const o = this.orders[orderId];
    if (!o) throw new Error(`no such order ${orderId}`);
    return o.delivered && o.daysSinceDelivery <= 30;
  }

  lookupOrder(orderId: string): Order {
    const o = this.orders[orderId];
    if (!o) throw new Error(`no such order ${orderId}`);
    return o;
  }

  triage = agentic({
    doc: 'Create a typed support ticket for the message about the given order.',
    params: {
      message: { type: 'string' },
      orderId: { type: 'string' },
    },
    returns: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        refund: { type: 'boolean' },
        note: { type: 'string' },
      },
      required: ['orderId', 'refund', 'note'],
    },
  });
}

const wasmOk = await CellVm.load()
  .then(() => true)
  .catch(() => false);

// -------------------------------------------------- extraction (no wasm) --

suite('LlmDriver code extraction', () => {
  it('extracts a fenced cellscript block', () => {
    const c = 'Sure, here is the cell:\n```cellscript\nreturn_result(1)\n```\nHope that helps.';
    expect(extractCode(c)).toBe('return_result(1)');
  });

  it('extracts a fenced block with no language tag', () => {
    expect(extractCode('```\nlet x = 2\nx + 1\n```')).toBe('let x = 2\nx + 1');
  });

  it('takes the FIRST block when a chatty model emits multiple', () => {
    const c = '```cellscript\nlet a = self.lookupOrder(orderId)\na\n```\n' +
      'and then\n```cellscript\nreturn_result(a)\n```';
    expect(extractCode(c)).toBe('let a = self.lookupOrder(orderId)\na');
  });

  it('accepts plain (unfenced) code that looks like a cell', () => {
    expect(extractCode('return_result({ ok: true })')).toBe('return_result({ ok: true })');
    expect(extractCode('  self.isRefundEligible(orderId)  ')).toBe(
      'self.isRefundEligible(orderId)',
    );
  });

  it('returns null for pure prose / empty so the retry can fire', () => {
    expect(extractCode('I am not sure how to help with that request.')).toBeNull();
    expect(extractCode('   ')).toBeNull();
    expect(extractCode('```cellscript\n\n```')).toBeNull();
  });
});

// ------------------------------------------------ mock seam (no wasm) --

suite('MockCompletion seam', () => {
  it('maps call-count to canned responses and records prompts', async () => {
    const mock = new MockCompletion(['first', 'second']);
    expect(await mock.fn('p0')).toBe('first');
    expect(await mock.fn('p1')).toBe('second');
    expect(mock.calls).toBe(2);
    expect(mock.prompts).toEqual(['p0', 'p1']);
  });

  it('repeats the last response past the end (non-strict)', async () => {
    const mock = new MockCompletion(['only']);
    expect(await mock.fn('a')).toBe('only');
    expect(await mock.fn('b')).toBe('only');
  });

  it('throws past the end when strict', async () => {
    const mock = new MockCompletion(['x'], true);
    await mock.fn('a');
    await expect(mock.fn('b')).rejects.toThrow(/exhausted/);
  });

  it('supports computed responses (branch on the prompt)', async () => {
    const mock = new MockCompletion([(p) => (p.includes('MAGIC') ? 'yes' : 'no')]);
    expect(await mock.fn('has MAGIC token')).toBe('yes');
  });
});

// --------------------------------------------- end-to-end (needs wasm) --

suite.skipIf(!wasmOk)('LlmDriver end-to-end against the wasm sandbox', () => {
  it('drives a SupportAgent task to a typed result via the mock', async () => {
    // A two-turn "model": explore, then decide. Fenced blocks like a real model.
    const mock = new MockCompletion([
      '```cellscript\nlet order = self.lookupOrder(orderId)\nprint("days", order.daysSinceDelivery)\norder\n```',
      '```cellscript\nreturn_result({ orderId: orderId, refund: self.isRefundEligible(orderId), note: "auto" })\n```',
    ]);
    const agent = new SupportAgent();
    const rt = await Runtime.create(new LlmDriver(mock.fn));
    const ticket = (await rt.run(agent, 'triage', ['where is my refund?', 'A-1'])) as {
      refund: boolean;
      orderId: string;
      note: string;
    };
    expect(ticket).toEqual({ orderId: 'A-1', refund: true, note: 'auto' });
    expect(agent.events().some((e) => e.kind === 'agentic:done')).toBe(true);
    // The seam was invoked exactly twice — one cell per turn, no waste.
    expect(mock.calls).toBe(2);
  });

  it('the out-of-window order yields refund=false through the same driver', async () => {
    const mock = new MockCompletion([
      '```cellscript\nreturn_result({ orderId: orderId, refund: self.isRefundEligible(orderId), note: "n" })\n```',
    ]);
    const rt = await Runtime.create(new LlmDriver(mock.fn));
    const t = (await rt.run(new SupportAgent(), 'triage', ['m', 'A-2'])) as { refund: boolean };
    expect(t.refund).toBe(false);
  });

  it('renderContext output is actually embedded in the prompt the model sees', async () => {
    const mock = new MockCompletion([
      '```cellscript\nreturn_result({ orderId: orderId, refund: true, note: "ok" })\n```',
    ]);
    await Runtime.create(new LlmDriver(mock.fn)).then((rt) =>
      rt.run(new SupportAgent(), 'triage', ['need help', 'A-1']),
    );
    const prompt = mock.prompts[0];
    // renderContext content:
    expect(prompt).toContain('SYSTEM: You are a support agent.');
    // triage is an arrow-field agentic declaration, so methodNameOf resolves
    // it to the placeholder name — the point here is the docstring is rendered.
    expect(prompt).toContain('Create a typed support ticket for the message');
    expect(prompt).toContain('RETURN CONTRACT:');
    expect(prompt).toContain('CAPABILITIES: self.isRefundEligible(...)');
    // the mock saw the args rendered by renderContext:
    expect(prompt).toContain('"orderId":"A-1"');
    // and the appended strict instruction:
    expect(prompt).toContain(CELL_INSTRUCTION.trim().split('\n')[1]);
    expect(prompt).toContain('EXACTLY ONE cell');
  });

  it('no-code retry path fires then succeeds', async () => {
    // Turn 1: the model returns prose (no cell) — the driver must re-ask and
    // recover WITHOUT consuming a runtime cell or failing the run.
    const mock = new MockCompletion([
      'I think we should issue a refund, but let me reconsider.', // no code -> retry
      '```cellscript\nreturn_result({ orderId: orderId, refund: true, note: "recovered" })\n```',
    ]);
    const agent = new SupportAgent();
    const rt = await Runtime.create(new LlmDriver(mock.fn));
    const t = (await rt.run(agent, 'triage', ['m', 'A-1'])) as { note: string };
    expect(t.note).toBe('recovered');
    // Two completions consumed, but only ONE cell ran in the VM (one turn).
    expect(mock.calls).toBe(2);
    const cellEvents = agent.events().filter((e) => e.kind === 'agentic:cell');
    expect(cellEvents.length).toBe(1);
    // The retry prompt carried the "no runnable cell" nudge.
    expect(mock.prompts[1]).toContain('NO RUNNABLE CELL');
  });

  it('gives up with an actionable error when the model never emits code', async () => {
    const mock = new MockCompletion(['nope, just chatting']); // repeats forever
    const rt = await Runtime.create(new LlmDriver(mock.fn, { maxNoCodeRetries: 1 }));
    await expect(rt.run(new SupportAgent(), 'triage', ['m', 'A-1'])).rejects.toThrow(
      /no extractable cell after 2 attempts/,
    );
  });
});
