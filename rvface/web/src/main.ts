/**
 * rvFACE web demo shell. Wires the engine seam (wasm if built, mock
 * otherwise) to the three UI areas: analyze pane, 1:1 compare pane and
 * the status strip. See ADR-0005.
 */

import './style.css';
import type { BackendKind, EngineFactory, RvFaceEngine, WeightBundle } from './engine';
import { mockFactory } from './engine-mock';
import { loadWasmFactory } from './engine-wasm';
import { emptyWeights, loadWeights } from './weights';
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

/** Pick implementation (wasm > mock) and load weights, once. */
async function resolveFactory(): Promise<{ factory: EngineFactory; weights: WeightBundle }> {
  if (factory && weights) return { factory, weights };

  const wasmFactory = await loadWasmFactory();
  if (wasmFactory) {
    status.log('wasm module found — loading weights…');
    const bundle = await loadWeights((p) => status.weightProgress(p));
    if (bundle) {
      factory = wasmFactory;
      weights = bundle;
      return { factory, weights };
    }
    status.log('weights missing from /models/ — using mock engine (run tools/fetch_and_convert.py)', 'warn');
  } else {
    status.log('wasm module not built — using mock (build rvface-wasm into src/wasm/ to switch)', 'warn');
  }

  factory = mockFactory;
  weights = emptyWeights(); // mock mode needs no weights
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
    if (engine.kind === 'mock') {
      status.log('results are simulated — MOCK engine active', 'warn');
    }
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
