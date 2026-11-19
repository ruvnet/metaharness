import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {describe, it, expect} from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml','utf8').replace(/\r\n/g,'\n');
const aggregate = workflow.match(/^  ci-pass:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1] ?? '';
describe('CI aggregate result', () => {
  it('waits for every other CI job, including Dream journeys and neural tests', () => {
    const jobs = [...workflow.slice(workflow.indexOf('\njobs:')).matchAll(/^  ([\w-]+):$/gm)].map(m => m[1]).filter(n => n !== 'ci-pass');
    const needs = aggregate.match(/needs: \[([^\]]+)\]/)?.[1].split(',').map(s => s.trim()) ?? [];
    expect(needs.sort()).toEqual(jobs.sort());
    expect(aggregate).toContain('if: ${{ always() }}');
  });
  it.each(['failure','cancelled','skipped','success'])('reports a Dream dependency result of %s truthfully', result => {
    const command = aggregate.match(/run: >-\n\s+(node -e [^\n]+)/)?.[1];
    expect(command).toBeTruthy();
    // Run the workflow's inline script directly: going through a shell makes the single quotes cmd.exe-dependent on Windows.
    const script = command!.slice(command!.indexOf("'") + 1, command!.lastIndexOf("'"));
    const run = () => execFileSync(process.execPath, ['-e', script], {env:{...process.env, NEEDS_JSON:JSON.stringify({'dream-validation':{result},node:{result:'success'}})},stdio:'pipe'});
    if (result === 'success') expect(run).not.toThrow();
    else expect(run).toThrow();
  });
});
