/**
 * rvFACE web demo shell. Wires the real wasm engine to the three UI areas:
 * analyze pane, 1:1 compare pane and the status strip (ADR-0005). There is
 * no mock: a missing wasm build or missing weights renders an error state
 * with setup instructions.
 */

import './style.css';
import type { BackendKind, EngineFactory, RvFaceEngine, WeightBundle } from './engine';
import { loadWasmFactory } from './engine-wasm';
import { loadWeights } from './weights';
import { AnalyzePane } from './ui/analyze';
import { ComparePane } from './ui/compare';
import { StatusBar } from './ui/statusbar';

function hasWebGpu(): boolean {
  return 'gpu' in navigator && (navigator as { gpu?: unknown }).gpu != null;
}

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <span class="brand-name">rvFACE</span>
      <span class="brand-sub">Rust + WASM face recognition</span>
    </div>
    <div class="backend-toggle" role="group" aria-label="Compute backend">
      <button type="button" data-backend="cpu">CPU</button>
      <button type="button" data-backend="webgpu">WebGPU</button>
    </div>
  </header>
  <main class="panes">
    <section class="pane" id="analyze-pane"></section>
    <section class="pane" id="compare-pane"></section>
  </main>
  <footer class="statusbar" id="statusbar"></footer>
`;

const status = new StatusBar(document.querySelector('#statusbar')!);

let engine: RvFaceEngine | null = null;
let factory: EngineFactory | null = null;
let weights: WeightBundle | null = null;
let requestedBackend: BackendKind = hasWebGpu() ? 'webgpu' : 'cpu';
let initSeq = 0;

const getEngine = () => engine;
const analyzePane = new AnalyzePane(document.querySelector('#analyze-pane')!, getEngine, status);
const comparePane = new ComparePane(document.querySelector('#compare-pane')!, getEngine, status);

const backendButtons = Array.from(
  app.querySelectorAll<HTMLButtonElement>('.backend-toggle button'),
);

function renderBackendToggle(): void {
  for (const btn of backendButtons) {
    btn.classList.toggle('active', btn.dataset['backend'] === requestedBackend);
  }
}

/** Full-width banner for unrecoverable setup problems (no mock fallback). */
function showFatalError(title: string, steps: string[]): void {
  document.querySelector('.fatal-error')?.remove();
  const banner = document.createElement('div');
  banner.className = 'fatal-error';
  const list = steps.map((s) => `<li><code>${s}</code></li>`).join('');
  banner.innerHTML = `
    <strong>${title}</strong>
    <p>This demo runs only the real Rust engine — build it, then reload:</p>
    <ol>${list}</ol>
  `;
  app.querySelector('.panes')!.before(banner);
}

/** Load the wasm factory and weight bundle, once. Throws on setup problems. */
async function resolveFactory(): Promise<{ factory: EngineFactory; weights: WeightBundle }> {
  if (factory && weights) return { factory, weights };

  const wasmFactory = await loadWasmFactory();
  if (!wasmFactory) {
    showFatalError('wasm module not found', [
      'python3 tools/fetch_and_convert.py',
      './web/build-wasm.sh',
      'npm run dev (or npm run build)',
    ]);
    throw new Error('wasm module not built — run ./web/build-wasm.sh');
  }

  status.log('wasm module loaded — fetching weights…');
  let bundle: WeightBundle;
  try {
    bundle = await loadWeights((p) => status.weightProgress(p));
  } catch (err) {
    showFatalError('model weights missing', [
      'python3 tools/fetch_and_convert.py',
      './web/build-wasm.sh  # copies models/ into web/public/models/',
    ]);
    throw err;
  }
  factory = wasmFactory;
  weights = bundle;
  return { factory, weights };
}

async function initEngine(backend: BackendKind): Promise<void> {
  const seq = ++initSeq;
  requestedBackend = backend;
  renderBackendToggle();
  status.log(`initializing engine (backend: ${backend})…`);

  try {
    const { factory: f, weights: w } = await resolveFactory();
    const next = await f.create(backend, w, (msg) => status.log(msg));
    if (seq !== initSeq) {
      next.dispose(); // a newer init won the race
      return;
    }
    engine?.dispose();
    engine = next;
    status.setEngine(engine.backend, engine.kind);
    status.log(`engine ready: ${engine.kind} on ${engine.backend}`);
    await analyzePane.reanalyze();
    comparePane.update();
  } catch (err) {
    status.log(`engine init failed: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

for (const btn of backendButtons) {
  btn.addEventListener('click', () => {
    const backend = btn.dataset['backend'] as BackendKind;
    if (backend !== requestedBackend || !engine) void initEngine(backend);
  });
}

if (!hasWebGpu()) {
  status.log('navigator.gpu not available — preselecting CPU backend');
}
renderBackendToggle();
void initEngine(requestedBackend);
