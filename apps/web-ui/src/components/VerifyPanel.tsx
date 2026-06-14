import { useState } from 'react';
import JSZip from 'jszip';
import { CheckCircle2, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { verifyFileMap } from '../generator';
import type { GenFile, VerifyReport, Severity } from '../generator';
import { Section } from './ui';

const SEV_STYLE: Record<Severity, string> = {
  high: 'border-red-500/40 bg-red-500/10 text-red-200',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  low: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  info: 'border-ink-700 bg-ink-800/60 text-slate-300',
  pass: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
};

const SEV_LABEL: Record<Severity, string> = { high: 'HIGH', medium: 'MED', low: 'LOW', info: 'INFO', pass: 'PASS' };

async function unzipToFileMap(file: File): Promise<GenFile[]> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const files: GenFile[] = [];
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  await Promise.all(
    entries.map(async (e) => {
      // Strip a single leading "<root>/" so paths match the verifier's expectations.
      const path = e.name.replace(/^[^/]+\//, '');
      files.push({ path, content: await e.async('string') });
    }),
  );
  return files;
}

export function VerifyPanel() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFilename(file.name);
    try {
      const files = await unzipToFileMap(file);
      setReport(verifyFileMap(files));
    } catch {
      setError('Could not read that zip. Is it a harness exported from this Studio?');
      setReport(null);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Section
          title="Verify a harness"
          desc="Drop a generated .zip — it's unzipped and checked entirely in your browser. Nothing is uploaded."
        >
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-ink-600 bg-ink-900/50 px-4 py-10 text-center transition hover:border-brand">
            <Upload size={22} className="text-brand-glow" />
            <span className="text-sm text-slate-200">Choose a harness .zip</span>
            <span className="text-xs text-slate-500">structure · kernel dep · host wiring · MCP policy · secrets</span>
            <input data-testid="verify-file" type="file" accept=".zip" className="hidden" onChange={onFile} />
          </label>
          {filename && <div className="mt-3 text-xs text-slate-400">Verified: <span className="font-mono text-slate-200">{filename}</span></div>}
          {error && <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
        </Section>

        <Section title="What it checks" desc="The same class of checks as the CLI's harness validate + mcp-scan.">
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-400">
            <li>package.json parses, has a name, declares @ruflo/kernel</li>
            <li>generator manifest + at least one host adapter present</li>
            <li>no unresolved <code className="text-slate-300">{'{{template vars}}'}</code></li>
            <li>MCP policy is default-deny, shell-gated, audited, timeout-bounded</li>
            <li>secret reads (.env) are denied</li>
          </ul>
        </Section>
      </div>

      <div className="space-y-5 lg:sticky lg:top-5 lg:self-start">
        <Section
          title="Verification report"
          desc={report ? `${report.passed} passed · ${report.failed} failed` : 'Select a zip to verify.'}
          right={
            report ? (
              <span className={`btn ${report.ok ? 'btn-ghost text-emerald-300' : 'btn-ghost text-red-300'} pointer-events-none`}>
                {report.ok ? <ShieldCheck size={16} /> : <ShieldAlert size={16} />}
                {report.ok ? 'VERIFIED' : 'ISSUES'}
              </span>
            ) : undefined
          }
        >
          {report ? (
            <div className="space-y-2">
              {report.checks.map((c) => (
                <div key={c.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${SEV_STYLE[c.severity]}`}>
                  <span className="mt-0.5 shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-bold">{SEV_LABEL[c.severity]}</span>
                  <div>
                    <div className="font-medium">{c.title}</div>
                    {c.severity !== 'pass' && <div className="text-xs opacity-90">{c.detail}</div>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/50 px-3 py-6 text-sm text-slate-400">
              <CheckCircle2 size={16} /> No report yet.
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
