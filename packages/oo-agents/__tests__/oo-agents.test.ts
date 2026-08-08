// End-to-end tests for the NOOA clone: the wasm sandbox, the self bridge, the
// typed auto-retry loop, and a SupportAgent mirroring the upstream README.
import { beforeAll, describe as suite, expect, it } from 'vitest';
import { Agent, agentic, Runtime, ScriptedDriver, CellVm, validate } from '../src/index.js';

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
    'A-3': { id: 'A-3', delivered: false, daysSinceDelivery: 0 },
  };

  // Ordinary method. Just TypeScript — deterministic, callable from cells.
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

  // Agentic method: the runtime hands this to the driver.
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

let vmOk = false;
beforeAll(async () => {
  try {
    await CellVm.load();
    vmOk = true;
  } catch {
    vmOk = false; // wasm artifact not built — suite skips (build with npm run build:wasm)
  }
});

// ------------------------------------------------------------------- tests --

suite.skipIf(!(await CellVm.load().then(() => true).catch(() => false)))(
  'oo-agents (wasm sandbox)',
  () => {
    it('REPL semantics: last expression, persistence, prints', async () => {
      const vm = await CellVm.load();
      vm.reset({ getField: () => null, callMethod: () => null });
      const a = vm.runCell('let x = 2 + 3\nprint("x is", x)\nx * 10');
      expect(a.kind).toBe('result');
      expect(a.value).toBe(50);
      expect(a.prints).toEqual(['x is 5']);
      const b = vm.runCell('x + 1'); // namespace persisted
      expect(b.value).toBe(6);
    });

    it('expanded builtins run end-to-end through the wasm boundary', async () => {
      const vm = await CellVm.load();
      vm.reset({ getField: () => null, callMethod: () => null });
      // string ops
      expect(vm.runCell('upper("aB")').value).toBe('AB');
      expect(vm.runCell('join(sort(split("c,a,b", ",")), "-")').value).toBe('a-b-c');
      // number ops
      expect(vm.runCell('min([4, 1, 3])').value).toBe(1);
      expect(vm.runCell('max(2, 9, 5)').value).toBe(9);
      expect(vm.runCell('abs(-7)').value).toBe(7);
      expect(vm.runCell('floor(3.9)').value).toBe(3);
      // array / object ops
      expect(vm.runCell('contains([1, 2, 3], 2)').value).toBe(true);
      expect(vm.runCell('slice([10, 20, 30, 40], 1, 3)').value).toEqual([20, 30]);
      expect(vm.runCell('get({a: 5}, "b", 99)').value).toBe(99);
    });

    it('adversarial input degrades to a clean error, never a wasm trap', async () => {
      const vm = await CellVm.load();
      vm.reset({ getField: () => null, callMethod: () => null });
      // deep nesting hits the parser depth guard, not a stack overflow
      const deep = vm.runCell('('.repeat(5000));
      expect(deep.kind).toBe('error');
      expect(deep.message).toContain('too deep');
      // division by zero and out-of-bounds index are typed errors the model sees
      expect(vm.runCell('1 / 0').kind).toBe('error');
      expect(vm.runCell('let a = [1]\na[9]').kind).toBe('error');
      // the instance stays usable after each error (no poisoned VM)
      expect(vm.runCell('1 + 1').value).toBe(2);
    });

    it('fuel exhaustion traps deterministically', async () => {
      const vm = await CellVm.load();
      vm.reset({ getField: () => null, callMethod: () => null });
      const out = vm.runCell('let i = 0\nwhile (true) { i = i + 1 }', 5000n);
      expect(out.kind).toBe('error');
      expect(out.message).toContain('fuel exhausted');
    });

    it('self bridge: state reads and capability calls, with host errors surfaced', async () => {
      const vm = await CellVm.load();
      vm.reset({
        getField: (n) => {
          if (n !== 'count') throw new Error(`unknown state field '${n}'`);
          return 41;
        },
        callMethod: (n, args) => {
          if (n !== 'bump') throw new Error(`unknown capability '${n}'`);
          return (args[0] as number) + 1;
        },
      });
      expect(vm.runCell('self.bump(self.count)').value).toBe(42);
      const err = vm.runCell('self.nope()');
      expect(err.kind).toBe('error');
      expect(err.message).toContain("unknown capability 'nope'");
    });

    it('agentic loop: code-as-action against the live agent, typed result', async () => {
      const agent = new SupportAgent();
      const driver = new ScriptedDriver([
        // model explores first — reads state through self, uses a capability
        'let order = self.lookupOrder(orderId)\nprint("days", order.daysSinceDelivery)\norder',
        // then decides and returns a typed ticket
        `let ok = self.isRefundEligible(orderId)
         return_result({ orderId: orderId, refund: ok, note: "auto-triaged" })`,
      ]);
      const rt = await Runtime.create(driver);
      const ticket = (await rt.run(agent, 'triage', ['where is my refund?', 'A-1'])) as {
        refund: boolean;
        orderId: string;
      };
      expect(ticket.refund).toBe(true);
      expect(ticket.orderId).toBe('A-1');
      // order A-2 is outside the 30-day window
      const driver2 = new ScriptedDriver([
        `return_result({ orderId: orderId, refund: self.isRefundEligible(orderId), note: "n" })`,
      ]);
      const rt2 = await Runtime.create(driver2);
      const t2 = (await rt2.run(agent, 'triage', ['msg', 'A-2'])) as { refund: boolean };
      expect(t2.refund).toBe(false);
      // events recorded
      expect(agent.events().some((e) => e.kind === 'agentic:done')).toBe(true);
    });

    it('typed auto-retry: contract violation is fed back and corrected', async () => {
      const agent = new SupportAgent();
      const driver = new ScriptedDriver(
        // first attempt returns the wrong shape (refund is a string)
        [`return_result({ orderId: orderId, refund: "yes", note: "bad" })`],
        // the retry hook sees the validation error and fixes the shape
        (error) => {
          expect(error).toContain('refund');
          return `return_result({ orderId: orderId, refund: true, note: "fixed" })`;
        },
      );
      const rt = await Runtime.create(driver);
      const t = (await rt.run(agent, 'triage', ['m', 'A-1'])) as { note: string };
      expect(t.note).toBe('fixed');
    });

    it('argument contracts are enforced before any cell runs', async () => {
      const agent = new SupportAgent();
      const rt = await Runtime.create(new ScriptedDriver([]));
      await expect(rt.run(agent, 'triage', [42, 'A-1'])).rejects.toThrow(
        /argument contract violated/,
      );
    });

    it('manifest introspection separates state, capabilities, agentic methods', () => {
      const m = new SupportAgent().manifest();
      expect(m.fields).toContain('orders');
      expect(m.capabilities).toEqual(
        expect.arrayContaining(['isRefundEligible', 'lookupOrder']),
      );
      // triage is an instance field (arrow-style agentic declaration), so it
      // shows as state to the sandbox but is runnable via Runtime.run.
    });
  },
);

suite('schema validator (no wasm needed)', () => {
  it('validates shapes and reports actionable paths', () => {
    const s = {
      type: 'object',
      properties: { a: { type: 'number', min: 0 }, b: { type: 'array', items: { type: 'string' } } },
      required: ['a'],
    } as const;
    expect(validate({ a: 1, b: ['x'] }, s)).toBeNull();
    expect(validate({ b: [] }, s)).toContain('missing required field "a"');
    expect(validate({ a: -1 }, s)).toContain('< min');
    expect(validate({ a: 1, b: [2] }, s)).toContain('$.b[0]');
  });
});
