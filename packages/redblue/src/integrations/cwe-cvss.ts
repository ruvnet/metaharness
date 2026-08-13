// SPDX-License-Identifier: MIT
//
// CWE + CVSS mapping for every redblue attack family.
//
// This turns redblue's internal taxonomy (AttackFamily + 0..1 severity) into the
// industry-standard vocabulary a bug-bounty triager expects: a CWE id (MITRE),
// the OWASP-LLM Top-10 anchor, and a CVSS 3.1 vector + base score band.
//
// SAFETY: this is metadata only — CWE/CVSS labels and a textual repro derived
// from the SAFE attack-family taxonomy (the adversarial OBJECTIVE, never an
// exploit string). Nothing here emits a working payload.

import type { AttackFamily, SeverityBand } from '../types.js';

/** A single CWE reference (MITRE Common Weakness Enumeration). */
export interface CweRef {
  id: string; // e.g. "CWE-77"
  name: string; // human-readable CWE title
}

/** Industry-standard mapping for one attack family. */
export interface FamilyTaxonomy {
  family: AttackFamily;
  /** Primary CWE plus any closely-related secondary CWEs. */
  cwe: CweRef[];
  /** OWASP LLM Top-10 anchor (mirrors the family meta, restated for triagers). */
  owaspLlm: string;
  /**
   * A representative CVSS 3.1 base vector for this class of finding. The actual
   * per-finding score is recomputed from the observed severity band (see
   * cvssForBand) — this vector communicates the *shape* (attack vector, impact)
   * a triager expects for the family.
   */
  cvssVector: string;
  /** Short impact statement for a bounty report. */
  impact: string;
}

/**
 * CWE/OWASP/CVSS-shape mapping for every family. Keyed by AttackFamily so the
 * compiler enforces completeness — add a family to the union and this fails to
 * type until it's mapped.
 *
 * CWE choices (TUNED against the LIVE HackerOne weakness taxonomy — 1631 entries,
 * 973 unique CWE — fetched 2026-06-27; see ADR-197). Every CWE id below was
 * verified present in that live set, and every `name` matches the exact string
 * HackerOne shows a triager (so a drafted report uses the label they expect):
 *  - prompt injection      → CWE-1427 (Improper Neutralization of Input Used for
 *                            LLM Prompting — the most precise CWE H1 lists for
 *                            this class) + CWE-77 (Command Injection - Generic).
 *  - indirect prompt injection → CWE-441 (Unintended Proxy or Intermediary /
 *                            "Confused Deputy" — the agent is tricked by
 *                            untrusted tool/RAG/web content into acting as an
 *                            intermediary carrying out the attacker's intent)
 *                            + CWE-829 (Inclusion of Functionality from
 *                            Untrusted Control Sphere — the untrusted-content-
 *                            as-instruction mechanism). Distinct from direct
 *                            prompt injection's CWE-1427/77: the attacker never
 *                            controls the user's own turn, only third-party
 *                            content the agent later ingests via a tool.
 *                            CAVEAT (added 2026-08-13, after the 2026-06-27
 *                            live fetch this comment block otherwise
 *                            describes): CWE-441/829 were chosen from MITRE's
 *                            published catalog but were NOT re-verified live
 *                            against the HackerOne weakness taxonomy the way
 *                            the original 9 CWE ids were (no HACKERONE_API_KEY
 *                            in this session). Treat them as offline-sourced
 *                            until a live TUNE-style pass confirms presence,
 *                            same as the other ids received in 0.1.3.
 *  - tool overreach        → CWE-250 (Execution with Unnecessary Privileges) +
 *                            CWE-862 (Missing Authorization); OWASP-LLM06
 *                            Excessive Agency.
 *  - data exfiltration     → CWE-200 (Information Disclosure) +
 *                            CWE-201 (Information Exposure Through Sent Data).
 *  - role confusion        → CWE-269 (Improper Privilege Management) +
 *                            CWE-1427 (LLM prompt-input neutralization) +
 *                            CWE-1426 (Improper Validation of Generative AI
 *                            Output — the precise insecure-output-handling CWE).
 *  - cost amplification    → CWE-770 (Allocation of Resources Without Limits) +
 *                            CWE-400 (Uncontrolled Resource Consumption) +
 *                            CWE-799 (Improper Control of Interaction Frequency).
 */
export const FAMILY_TAXONOMY: Record<AttackFamily, FamilyTaxonomy> = {
  direct_prompt_injection: {
    family: 'direct_prompt_injection',
    cwe: [
      { id: 'CWE-1427', name: 'Improper Neutralization of Input Used for LLM Prompting' },
      { id: 'CWE-77', name: 'Command Injection - Generic' },
    ],
    owaspLlm: 'LLM01 Prompt Injection',
    // Network attack, low complexity, no privileges, integrity impact dominant.
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:H/A:N',
    impact:
      'Attacker-controlled text overrides the system policy, causing the agent to follow injected instructions instead of its own (loss of integrity over the model’s behavior).',
  },
  indirect_prompt_injection: {
    family: 'indirect_prompt_injection',
    cwe: [
      { id: 'CWE-441', name: 'Unintended Proxy or Intermediary ("Confused Deputy")' },
      { id: 'CWE-829', name: 'Inclusion of Functionality from Untrusted Control Sphere' },
    ],
    owaspLlm: 'LLM01 Prompt Injection (indirect)',
    // Attacker needs no interaction with the target's own user; content arrives
    // via a tool/document the agent trusts as data. Same integrity shape as
    // direct injection but a different attack vector (content-borne, not user-borne).
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:H/A:N',
    impact:
      'Instructions embedded in third-party content the agent ingests via a tool (retrieved document, tool result, web page) are followed as if they were operator instructions, making the agent an unwitting confused deputy for the content\'s source.',
  },
  tool_overreach: {
    family: 'tool_overreach',
    cwe: [
      { id: 'CWE-250', name: 'Execution with Unnecessary Privileges' },
      { id: 'CWE-862', name: 'Missing Authorization' },
    ],
    owaspLlm: 'LLM06 Excessive Agency',
    // Out-of-scope/destructive tool action — high integrity + availability impact.
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:H/A:H',
    impact:
      'Agent invokes a tool outside its intended scope (e.g. a destructive or unrelated action), performing privileged operations without confirmation or authorization.',
  },
  data_exfiltration_attempt: {
    family: 'data_exfiltration_attempt',
    cwe: [
      { id: 'CWE-200', name: 'Information Disclosure' },
      { id: 'CWE-201', name: 'Information Exposure Through Sent Data' },
    ],
    owaspLlm: 'LLM06 Sensitive Information Disclosure',
    // Confidentiality is the dominant impact.
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N',
    impact:
      'Agent discloses sensitive context it holds (secrets, other users’ data, internal configuration) to an actor not authorized to see it.',
  },
  role_confusion: {
    family: 'role_confusion',
    cwe: [
      { id: 'CWE-269', name: 'Improper Privilege Management' },
      { id: 'CWE-1427', name: 'Improper Neutralization of Input Used for LLM Prompting' },
      { id: 'CWE-1426', name: 'Improper Validation of Generative AI Output' },
    ],
    owaspLlm: 'LLM01 Prompt Injection / Insecure Output Handling',
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:H/A:N',
    impact:
      'Agent adopts a claimed elevated authority/persona on assertion alone, loosening its safeguards (privilege management failure driven by unneutralized prompt input).',
  },
  cost_amplification: {
    family: 'cost_amplification',
    cwe: [
      { id: 'CWE-770', name: 'Allocation of Resources Without Limits or Throttling' },
      { id: 'CWE-400', name: 'Uncontrolled Resource Consumption' },
      { id: 'CWE-799', name: 'Improper Control of Interaction Frequency' },
    ],
    owaspLlm: 'LLM06 Excessive Agency (denial-of-wallet)',
    // Availability/cost is the dominant impact (denial-of-wallet).
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H',
    impact:
      'Agent can be driven into unbounded/expensive work (loops, oversized outputs, repeated tool calls) — a denial-of-wallet / availability condition.',
  },
};

/**
 * CVSS 3.1 base-score band representative of a redblue severity band.
 *
 * redblue scores severity on 0..1; HackerOne/CVSS use a 0..10 base score with
 * named bands. We map honestly band-to-band (None/Low/Medium/High/Critical),
 * picking a representative numeric score inside each CVSS band rather than
 * over-claiming. The redblue 0..1 score is preserved verbatim in the report so
 * a triager can see both.
 */
export interface CvssBand {
  /** Representative CVSS 3.1 base score (0.0–10.0). */
  baseScore: number;
  /** CVSS qualitative rating. */
  rating: 'None' | 'Low' | 'Medium' | 'High' | 'Critical';
  /** HackerOne severity rating field value (lowercase). */
  hackeroneSeverity: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Map a redblue SeverityBand → a CVSS band. The mapping is deliberately
 * conservative (it does not inflate): Info→None, Low→Low, Med→Medium,
 * High→High, Critical→Critical.
 */
export function cvssForBand(band: SeverityBand): CvssBand {
  switch (band) {
    case 'Info':
      return { baseScore: 0.0, rating: 'None', hackeroneSeverity: 'none' };
    case 'Low':
      return { baseScore: 3.1, rating: 'Low', hackeroneSeverity: 'low' };
    case 'Med':
      return { baseScore: 5.3, rating: 'Medium', hackeroneSeverity: 'medium' };
    case 'High':
      return { baseScore: 7.5, rating: 'High', hackeroneSeverity: 'high' };
    case 'Critical':
      return { baseScore: 9.1, rating: 'Critical', hackeroneSeverity: 'critical' };
    default: {
      // Exhaustiveness guard — unreachable unless SeverityBand grows.
      const _never: never = band;
      return { baseScore: 0.0, rating: 'None', hackeroneSeverity: 'none' };
    }
  }
}

/** Look up the taxonomy for a family (always defined — the record is total). */
export function taxonomyForFamily(family: AttackFamily): FamilyTaxonomy {
  return FAMILY_TAXONOMY[family];
}

/** Convenience: the primary (first) CWE for a family. */
export function primaryCwe(family: AttackFamily): CweRef {
  return FAMILY_TAXONOMY[family].cwe[0];
}
