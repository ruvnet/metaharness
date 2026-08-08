// Pod integration tests (ADR-241/ADR-242): an oo-agents Agent presented AS a
// radio PodAgent, coordinating a 3-agent POD over the passive-awareness bus.
//
// The task is decomposed so ONE agent's discovery is needed by ANOTHER: agent2
// explores its region, finds fact 3, which bears on agent1's sub-question.
//   - Under PASSIVE awareness the discovery folds into agent1's next execute
//     step for free, so the pod resolves cheaply DURING Execute.
//   - Under the BLOCKING no-sharing ablation the same fact reaches agent1 only
//     at the Review broadcast, after each agent pays one foreground
//     blockingReceive — strictly MORE steps.
//   - With sharing switched OFF entirely the discovery is never posted, no
//     channel delivers it, and the pod FAILS (visibility is not synthesis).
//
// Everything is deterministic: no Date.now / Math.random, so the numbers below
// are asserted exactly and a re-run reproduces them bit-for-bit.
import { beforeAll, describe as suite, expect, it } from 'vitest';
import {
  Agent,
  Runtime,
  ScriptedDriver,
  CellVm,
  PodMemberAgent,
  asPodAgent,
  buildPod,
  makePodTask,
  runPod,
  runPodExample,
  SequentialPodDriver,
} from '../src/index.js';

const totalSteps = (steps: Record<string, number>): number =>
  Object.values(steps).reduce((n, s) => n + s, 0);

// ------------------------------------------------------------ pod resolution --

suite('pod over the passive-awareness bus (no wasm needed)', () => {
  it('passive awareness delivers the cross discovery mid-execute and the pod resolves', () => {
    const { result, resolved, members } = runPod({ mode: 'passive' });

    // The pod resolves and every agent approves the draft.
    expect(resolved).toBe(true);
    expect(result.approved).toBe(true);

    // agent1's sub-question needs fact 3, which lives in agent2's region.
    const agent1 = members[1];
    expect(agent1.needs).toContain(3);
    expect(agent1.held).toContain(3);

    // Crucially, agent1 received fact 3 DURING Execute via a passive fold — not
    // only at the Review broadcast. Its worklog carries an execute-time fold.
    const foldedInExecute = agent1
      .worklogEntries()
      .some((e) => e.startsWith('folded ') && e.includes('3'));
    expect(foldedInExecute).toBe(true);

    // agent2 is the discoverer/sharer of fact 3, addressed to agent1.
    const agent2 = members[2];
    expect(agent2.worklogEntries().some((e) => e.includes('share @agent1'))).toBe(true);
  });

  it('the blocking no-sharing control resolves only later — strictly MORE steps', () => {
    const passive = runPod({ mode: 'passive' });
    const blocking = runPod({ mode: 'blocking' });

    // Both end resolved (blocking recovers the fact at Review)...
    expect(passive.resolved).toBe(true);
    expect(blocking.resolved).toBe(true);

    // ...but the no-sharing arm costs strictly more foreground steps: each agent
    // pays one blockingReceive, and the cross fact surfaces only at Review.
    const p = totalSteps(passive.result.steps);
    const b = totalSteps(blocking.result.steps);
    expect(b).toBeGreaterThan(p);
    expect(b - p).toBe(passive.members.length); // exactly one blockingReceive per agent

    // In blocking mode agent1 did NOT fold fact 3 during Execute; it only
    // absorbed it at the Review broadcast.
    const agent1 = blocking.members[1];
    const execFold = agent1.worklogEntries().some((e) => e.startsWith('folded '));
    const reviewFold = agent1.worklogEntries().some((e) => e.startsWith('review folded '));
    expect(execFold).toBe(false);
    expect(reviewFold).toBe(true);
  });

  it('with sharing switched off the pod FAILS — the fact is found but never posted', () => {
    // agent2 discovers fact 3 but withholds it: no @-mention, and nothing to
    // surface at Review. No comms policy can recover a conclusion no one shares.
    const silo = runPod({ mode: 'passive', shareCrossFacts: { 2: false } });
    expect(silo.resolved).toBe(false);
    expect(silo.result.approved).toBe(false);

    const agent1 = silo.members[1];
    expect(agent1.held).not.toContain(3);
    // agent2 DID discover it (it is in agent2's held) — the gap is delivery.
    expect(silo.members[2].held).toContain(3);
  });

  it('is deterministic: identical inputs reproduce the run bit-for-bit', () => {
    const a = runPod({ mode: 'passive' });
    const b = runPod({ mode: 'passive' });
    expect(a.result.steps).toEqual(b.result.steps);
    expect(a.result.messages).toBe(b.result.messages);
    expect(a.result.answer).toBe(b.result.answer);
    expect(a.members.map((m) => m.held)).toEqual(b.members.map((m) => m.held));
  });

  it('holds the exact expected step budget (locks the passive < blocking gap)', () => {
    // Passive: explore(3) + execute(4) + review(3) + draft(1) = 11.
    // Blocking: the same plus one blockingReceive per agent (=3) = 14.
    expect(totalSteps(runPod({ mode: 'passive' }).result.steps)).toBe(11);
    expect(totalSteps(runPod({ mode: 'blocking' }).result.steps)).toBe(14);
  });

  it('scattered exploration order does not change the outcome (only the path)', () => {
    // A different (deterministic) unit ordering still resolves under passive
    // awareness — the result depends on sharing, not on a lucky order.
    for (const seed of [1, 2, 7, 42]) {
      const run = runPod({ mode: 'passive', scatterSeed: seed });
      expect(run.resolved).toBe(true);
      expect(run.result.approved).toBe(true);
    }
  });
});

// --------------------------------------------------------- adapter/OO mapping --

suite('adapter maps pod hooks onto OO capabilities (no wasm needed)', () => {
  it('a PodMemberAgent is a real oo-agents Agent with a clean manifest', () => {
    const task = makePodTask();
    const { members } = buildPod(task);
    const m = members[0];
    expect(m).toBeInstanceOf(Agent);

    const man = m.manifest();
    // Domain state is fields; the pod actions are capabilities; summarize is the
    // one agentic (model-driven) method.
    expect(man.fields).toEqual(expect.arrayContaining(['region', 'needs', 'held', 'worklog']));
    expect(man.capabilities).toEqual(
      expect.arrayContaining(['exploreUnit', 'absorb', 'resolved', 'classify', 'survey']),
    );
    expect(man.agentic).toContain('summarize');
    // orchestration wiring stays private — never exposed to the sandbox.
    expect(man.fields).not.toContain('shareCrossFacts');
  });

  it('the adapter presents a well-formed radio PodAgent whose hooks post worklog', () => {
    const task = makePodTask();
    const { members } = buildPod(task);
    const podAgent = asPodAgent(members[1], new SequentialPodDriver());

    expect(podAgent.name).toBe('agent1');
    // explore() drives the capability and posts to the worklog.
    const findings = podAgent.explore(0);
    expect(findings[0]).toContain('region units');
    expect(members[1].worklogEntries().some((e) => e.startsWith('explore@'))).toBe(true);

    // proposePartition/approvePartition round-trip through capabilities.
    const partition = podAgent.proposePartition({});
    expect(podAgent.approvePartition(partition)).toBe(true);
  });
});

// ------------------------------------------------------ worked example (docs) --

suite('worked example for docs', () => {
  it('runPodExample contrasts passive vs blocking vs silo', () => {
    const ex = runPodExample();
    expect(ex.passive.approved).toBe(true);
    expect(ex.blocking.approved).toBe(true);
    expect(ex.silo.approved).toBe(false);
    expect(ex.blocking.steps).toBeGreaterThan(ex.passive.steps);
    expect(ex.narrative).toContain('Passive awareness resolves');
  });
});

// ----------------------------------------- OO async seam composes (wasm only) --

// The agentic method demonstrates that the composition is real in BOTH
// directions: the same object that serves as a radio PodAgent still runs the
// oo-agents code-as-action loop, driven by the standard Runtime + ScriptedDriver.
let vmOk = false;
beforeAll(async () => {
  try {
    await CellVm.load();
    vmOk = true;
  } catch {
    vmOk = false; // wasm artifact not built — the async-seam test skips
  }
});

suite.skipIf(!(await CellVm.load().then(() => true).catch(() => false)))(
  'OO agentic seam composes with the pod role (wasm sandbox)',
  () => {
    it('a pod member runs its agentic summarize() via a scripted driver', async () => {
      const { members } = buildPod(makePodTask());
      const member = members[2] as PodMemberAgent;
      // Give the agent some worklog history through the pod hooks first.
      const pod = asPodAgent(member);
      pod.explore(0);
      pod.executeStep(['Q2'], []);

      // The model writes ONE cell that composes the status from self — real
      // code-as-action against the same object the bus drives.
      const driver = new ScriptedDriver(['return_result(self.status())']);
      const rt = await Runtime.create(driver);
      const status = (await rt.run(member, 'summarize', [])) as string;
      expect(typeof status).toBe('string');
      expect(status).toContain('agent2');
      expect(member.events().some((e) => e.kind === 'agentic:done')).toBe(true);
    });
  },
);
