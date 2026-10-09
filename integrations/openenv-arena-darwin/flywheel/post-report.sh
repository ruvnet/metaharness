#!/usr/bin/env bash
# Posts the day's flywheel REPORT TEXT to Slack. OFF by default. It can only post what report.mjs renders.
#
#   post-report.sh [--date YYYY-MM-DD] [--post]
#
# Without --post (the default) it prints the exact message it would send, and to which channel, and exits 0.
# With --post it sends only when config notify.postEnabled is true AND notify.slackChannel is a channel id.
# Run it by hand, or from a timer a human adds; arena-flywheel.service never calls it.
#
# It cannot run, steer or approve the flywheel: there is no LLM in the path, it never calls the arena, and its
# only Slack call is chat.postMessage carrying report.mjs's text byte for byte. Slack messages are never approval.
# Transport: the cognitum-slack MCP binary over stdio JSON-RPC (initialize, then tools/call slack_send_message).
# That binary reads its own token from SLACK_MCP_TOKEN_FILE; this script never opens the token file, and the
# binary gets a scrubbed environment (PATH, HOME, SLACK_MCP_TOKEN_FILE) so no other token can leak in.
# The text is rendered with report.mjs --strict: if anything needed redaction, nothing is posted.
#
# notify section of ~/.config/arena-flywheel/config.json:
#   postEnabled (default false), slackChannel ("C0123ABCD"),
#   slackMcpCommand (default ~/.local/bin/cognitum-slack-mcp), slackTokenFile (default ~/.config/cognitum-slack/token)
# Exit: 0 printed, posted, or posting disabled | 1 send failed | 2 bad arguments, config or channel
#       | 4 report.mjs refused (--strict redaction) or failed
set -euo pipefail
umask 077

SELF_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
NODE=${NODE:-$(command -v node || true)}
CONF=${ARENA_FLYWHEEL_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/arena-flywheel/config.json}

die() { printf 'post-report: %s\n' "$2" >&2; exit "$1"; }
[[ -n $NODE && -x $NODE ]] || die 2 "node not found"

DATE='' POST=0
while [[ $# -gt 0 ]]; do
  case $1 in
    --post) POST=1; shift ;;
    --date) [[ ${2:-} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die 2 "--date needs YYYY-MM-DD"; DATE=$2; shift 2 ;;
    -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die 2 "unknown argument: $1" ;;
  esac
done

# notify settings, one per line: postEnabled, slackChannel, slackMcpCommand, slackTokenFile. A missing config
# means posting is disabled.
SETTINGS=$("$NODE" -e '
  const fs = require("fs"), path = require("path"), home = process.env.HOME;
  let n = {};
  if (fs.existsSync(process.argv[1])) {
    let c; try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.error("config is not valid JSON"); process.exit(2); }
    n = c && typeof c.notify === "object" && c.notify !== null ? c.notify : {};
  }
  const s = v => (typeof v === "string" ? v.replace(/[\r\n]/g, "") : "");
  const tilde = v => (v.startsWith("~/") ? path.join(home, v.slice(2)) : v);
  console.log([n.postEnabled === true ? "true" : "false", s(n.slackChannel),
    tilde(s(n.slackMcpCommand) || "~/.local/bin/cognitum-slack-mcp"),
    tilde(s(n.slackTokenFile) || "~/.config/cognitum-slack/token")].join("\n"));
' "$CONF") || die 2 "cannot read $CONF"
{ read -r ENABLED; read -r CHANNEL; read -r MCP_CMD; read -r TOKEN_FILE; } <<<"$SETTINGS"

TODAY=$(TZ=America/Toronto date +%F)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
args=(--format slack --strict --today "$TODAY" --now "$NOW")
[[ -n $DATE ]] && args+=(--date "$DATE")
rc=0
TEXT=$("$NODE" "$SELF_DIR/report.mjs" "${args[@]}") || rc=$?
# 3 = no status for the day: a "NO STATUS" message is still worth sending.
[[ $rc -eq 0 || $rc -eq 3 ]] || die 4 "report.mjs refused or failed (exit $rc); nothing sent"

if [[ $POST -eq 0 ]]; then
  printf 'post-report: DRY RUN (no --post). Would send to channel %s (notify.postEnabled=%s):\n%s\n' \
    "${CHANNEL:-<unset>}" "$ENABLED" "$TEXT"
  exit 0
fi
if [[ $ENABLED != true ]]; then
  echo "post-report: posting is disabled (notify.postEnabled is not true in $CONF); nothing sent"
  exit 0
fi
[[ $CHANNEL =~ ^[CG][A-Z0-9]{8,12}$ ]] || die 2 "notify.slackChannel must be a Slack channel id like C0123ABCD"
[[ -x $MCP_CMD ]] || die 2 "Slack MCP command not executable: $MCP_CMD"
[[ -f $TOKEN_FILE ]] || die 2 "Slack token file not found at $TOKEN_FILE (it is read by the MCP binary, not here)"

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s' "$TEXT" >"$TMP"

# Minimal JSON-RPC client. Arguments: <mcp command> <channel> <text file>.
read -r -d '' CLIENT <<'JS' || true
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [cmd, channel, textFile] = process.argv.slice(1);
const text = fs.readFileSync(textFile, 'utf8');
const scrub = s => String(s).replace(/xox[a-z]-[A-Za-z0-9-]+/g, '[REDACTED]').replace(/\s+/g, ' ').slice(-240);
const child = spawn(cmd, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, SLACK_MCP_TOKEN_FILE: process.env.SLACK_MCP_TOKEN_FILE } });
let buf = '', errTail = '';
const pending = new Map();
const fail = msg => { console.error(`post-report: ${scrub(msg)}${errTail ? ` | server: ${scrub(errTail)}` : ''}`); try { child.kill('SIGTERM'); } catch {} process.exit(1); };
const send = m => child.stdin.write(`${JSON.stringify(m)}\n`);
const exited = new Promise((_, rej) => child.on('exit', code => rej(new Error(`MCP server exited (code ${code})`))));
exited.catch(() => {});
const call = (id, method, params) => Promise.race([exited, new Promise((res, rej) => {
  pending.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params });
})]);
child.on('error', e => fail(`cannot start MCP server: ${e.code ?? e.message}`));
child.stdin.on('error', () => {});
child.stderr.on('data', d => { errTail = (errTail + d).slice(-600); });
child.stdout.on('data', d => {
  buf += d;
  for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.rej(new Error(`rpc error ${m.error.code ?? ''} ${m.error.message ?? ''}`)) : p.res(m.result); }
  }
});
setTimeout(() => fail('timed out after 30 s'), 30000).unref();
(async () => {
  try {
    await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'arena-flywheel-post-report', version: '1' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const r = await call(2, 'tools/call', { name: 'slack_send_message', arguments: { channel, text } });
    if (!r || r.isError) throw new Error(`slack_send_message failed: ${r?.content?.[0]?.text ?? 'no result'}`);
    console.log(`post-report: posted ${text.length} chars to ${channel}`);
    child.stdin.end(); child.kill('SIGTERM'); process.exit(0);
  } catch (e) { fail(e.message); }
})();
JS

env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$HOME" SLACK_MCP_TOKEN_FILE="$TOKEN_FILE" \
  "$NODE" -e "$CLIENT" "$MCP_CMD" "$CHANNEL" "$TMP"
