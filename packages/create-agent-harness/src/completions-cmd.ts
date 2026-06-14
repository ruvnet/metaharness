// SPDX-License-Identifier: MIT
//
// `harness completions <bash|zsh|fish>` — emit shell completion
// scripts. Mirrors the standard CLI convention (gh, npm, etc.).
// Users source the output:
//
//   harness completions bash >> ~/.bash_completion
//   harness completions zsh  >  ~/.zsh/_harness
//   harness completions fish >  ~/.config/fish/completions/harness.fish

export type SubcommandResult = { code: number; lines: string[] };

const SUBCOMMANDS = [
  'sign', 'verify', 'doctor',
  'federate', 'secrets', 'validate',
  'mcp', 'publish', 'upgrade',
  'completions', 'sbom', 'audit',
  // iter 55 PR-#1 additions
  'mcp-scan', 'analyze-repo',
  // iter 66 — kernel-version skew diagnostic
  'diag',
  // iter 97 — export MCP + claims as single JSON
  'export-config',
  // iter 105 — diff two harness manifests + per-file fingerprints
  'compare',
  'help',
] as const;

const SECRETS_SUBSUBS = ['check', 'fetch', 'validate-token', 'help'] as const;
const MCP_SUBSUBS = ['ls', 'invoke', 'help'] as const;
const FEDERATE_SUBSUBS = ['init', 'add', 'remove', 'list', 'status', 'help'] as const;

function bashCompletion(): string {
  return `# bash completion for harness
_harness_completion() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]:-}"

  # Top-level subcommands
  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(' ')}" -- "$cur") )
    return 0
  fi

  case "$cmd" in
    secrets)
      [ $COMP_CWORD -eq 2 ] && COMPREPLY=( $(compgen -W "${SECRETS_SUBSUBS.join(' ')}" -- "$cur") )
      ;;
    mcp)
      [ $COMP_CWORD -eq 2 ] && COMPREPLY=( $(compgen -W "${MCP_SUBSUBS.join(' ')}" -- "$cur") )
      ;;
    federate)
      [ $COMP_CWORD -eq 2 ] && COMPREPLY=( $(compgen -W "${FEDERATE_SUBSUBS.join(' ')}" -- "$cur") )
      ;;
    completions)
      [ $COMP_CWORD -eq 2 ] && COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") )
      ;;
  esac
  return 0
}
complete -F _harness_completion harness
`;
}

function zshCompletion(): string {
  return `#compdef harness
# zsh completion for harness

_harness() {
  local -a subcommands
  subcommands=(
    'sign:produce or update the witness manifest'
    'verify:verify the witness manifest signature'
    'doctor:smoke-check a scaffolded harness'
    'federate:manage federation peers (init/add/remove/list/status)'
    'secrets:GCP Secret Manager: check / fetch / validate-token'
    'validate:umbrella: doctor + verify + path-guard + mcp + secrets'
    'mcp:list MCP servers / dispatch a tool through the claim check'
    'publish:pin the harness manifest to IPFS via Pinata (dry-run default)'
    'upgrade:re-render template + drift plan (--apply to apply)'
    'completions:emit shell completion scripts (bash/zsh/fish)'
    'sbom:emit SPDX-2.3 SBOM for the harness'
    'audit:npm audit per-harness with structured output'
    'mcp-scan:security-scan the harness MCP surface (policy + perms + deps)'
    'analyze-repo:recommend a harness from a local repo'
    'diag:kernel-version skew check (ADR-027 diagnostic)'
    'export-config:emit MCP servers + claims + permissions as a single JSON'
    'compare:diff two harnesses (manifest + per-file fingerprints, ADR-031 --bundle)'
    'help:show help'
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'harness command' subcommands
    return
  fi

  case "$words[2]" in
    secrets)
      (( CURRENT == 3 )) && compadd ${SECRETS_SUBSUBS.join(' ')}
      ;;
    mcp)
      (( CURRENT == 3 )) && compadd ${MCP_SUBSUBS.join(' ')}
      ;;
    federate)
      (( CURRENT == 3 )) && compadd ${FEDERATE_SUBSUBS.join(' ')}
      ;;
    completions)
      (( CURRENT == 3 )) && compadd bash zsh fish
      ;;
  esac
}

_harness "$@"
`;
}

function fishCompletion(): string {
  const subs = SUBCOMMANDS.map(s => `complete -c harness -f -n '__fish_use_subcommand' -a ${s}`).join('\n');
  return `# fish completion for harness
${subs}

# secrets sub-subs
complete -c harness -f -n '__fish_seen_subcommand_from secrets' -a '${SECRETS_SUBSUBS.join(' ')}'
# mcp sub-subs
complete -c harness -f -n '__fish_seen_subcommand_from mcp' -a '${MCP_SUBSUBS.join(' ')}'
# federate sub-subs
complete -c harness -f -n '__fish_seen_subcommand_from federate' -a '${FEDERATE_SUBSUBS.join(' ')}'
# completions sub-subs
complete -c harness -f -n '__fish_seen_subcommand_from completions' -a 'bash zsh fish'
`;
}

export function completionsCmd(args: string[]): SubcommandResult {
  const shell = args[0];
  switch (shell) {
    case 'bash':
      return { code: 0, lines: [bashCompletion()] };
    case 'zsh':
      return { code: 0, lines: [zshCompletion()] };
    case 'fish':
      return { code: 0, lines: [fishCompletion()] };
    case undefined:
    case 'help':
      return {
        code: 0,
        lines: [
          'Usage: harness completions <bash|zsh|fish>',
          '',
          'Emit a shell completion script for the given shell.',
          '',
          'Examples:',
          '  harness completions bash >> ~/.bash_completion',
          '  harness completions zsh  >  ~/.zsh/_harness',
          '  harness completions fish >  ~/.config/fish/completions/harness.fish',
        ],
      };
    default:
      return {
        code: 2,
        lines: [`Unknown shell: ${shell} (expected bash, zsh, or fish)`],
      };
  }
}
