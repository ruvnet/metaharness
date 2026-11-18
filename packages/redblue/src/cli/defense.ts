// `redblue defense <replay|verify|benchmark|help>` — the blue-team evidence side.
//
// Red actors find weaknesses in a system you own; this subcommand checks what the
// defence would have done about real findings. It forwards to
// @metaharness/artex-defense, which imports an ARTEX findings export or
// identity/edge telemetry under a scoped manifest, replays a baseline and a
// candidate policy over the same events, simulates (never enforces) a session
// quarantine, and pins the report to a MetaHarness receipt chain. Offline: no
// network, no shell, nothing applied to a live system.
//
// The package is loaded on first use, so the other redblue commands never pay for it.

export interface DefenseResult {
  code: number;
  lines: string[];
}

interface ArtexDispatchResult {
  code: number;
  lines: string[];
  errors: string[];
}

type ArtexDispatch = (action: string | undefined, args?: string[]) => Promise<ArtexDispatchResult>;

const DEFENSE_HELP = `redblue defense — offline defensive evidence replay (@metaharness/artex-defense)

Usage:
  redblue defense replay MANIFEST INPUT NEW_REPORT [monitor|simulate]
  redblue defense verify MANIFEST INPUT REPORT TRUSTED_TAIL_SHA256
  redblue defense benchmark
  redblue defense help

MANIFEST binds one evidence file (ARTEX findings CSV or JSON telemetry) to a
tenant, case and SHA-256. replay compares a baseline and a candidate policy,
writes a new report (never overwrites), and prints the receipt tail hash.
Keep that hash somewhere the report cannot reach: verify recomputes everything
from the original evidence and accepts only the exact report bytes.
simulate records a virtual session quarantine; nothing is enforced.`;

export async function cmdDefense(
  argv: string[],
  load: () => Promise<{ dispatch: ArtexDispatch }> = () => import('@metaharness/artex-defense'),
): Promise<DefenseResult> {
  const [action, ...args] = argv;
  if (action === undefined || action === 'help' || action === '--help' || action === '-h') {
    return { code: 0, lines: [DEFENSE_HELP] };
  }
  let dispatch: ArtexDispatch;
  try {
    ({ dispatch } = await load());
  } catch {
    return {
      code: 1,
      lines: ['redblue defense: @metaharness/artex-defense is not installed. Run: npm install @metaharness/artex-defense'],
    };
  }
  const r = await dispatch(action, args);
  return { code: r.code, lines: [...r.lines, ...r.errors.map((e) => `redblue defense: ${e}`)] };
}
