// Click-funnel domain model + deterministic traffic simulator.
//
// The funnel is Ad Click → Landing → Opt-in → Checkout → Upsell. The thing being
// evolved is the funnel's OPERATING POLICY — eight string levers (headline
// strategy, CTA copy, form length, page weight, social proof, offer framing,
// checkout flow, urgency tactic). The simulator is seeded and pure: the same
// (policy, cohort) pair always produces the same numbers, so every flywheel
// promotion is replayable. Data source is SYNTHETIC by construction — this is a
// harness demo, not a live-traffic claim.

/** The eight levers and their allowed values. First value = the gen-0 default. */
export const LEVERS = {
  headline: ['generic_welcome', 'benefit_direct', 'curiosity_gap', 'social_proof_led', 'urgency_led'],
  cta: ['generic_submit', 'value_button', 'first_person', 'risk_reversal'],
  form: ['full_profile', 'email_name', 'email_only'],
  page_weight: ['heavy_rich', 'balanced', 'lean_fast'],
  social_proof: ['none', 'logos', 'testimonials', 'live_counter'],
  offer_framing: ['feature_list', 'outcome_promise', 'guarantee_led', 'anchored_discount'],
  checkout: ['multi_step', 'single_page', 'express_wallet'],
  urgency: ['none', 'honest_deadline', 'fake_countdown'],
};

/** Gen-0 root: the untuned funnel every promotion chains back to. */
export const ROOT_POLICY = Object.fromEntries(Object.entries(LEVERS).map(([k, v]) => [k, v[0]]));

// Per-lever effects on stage probabilities. `pressure` models manipulative
// intensity (drives refunds + compliance review); `darkPattern` is a hard
// compliance violation regardless of how well it converts.
const EFFECTS = {
  headline: {
    generic_welcome: {},
    benefit_direct: { engage: 0.06, optin: 0.01 },
    curiosity_gap: { engageCold: 0.05, engageWarm: -0.01 },
    social_proof_led: { engageCold: 0.02, engageWarm: 0.05 },
    urgency_led: { engage: 0.03, pressure: 0.6 },
  },
  cta: {
    generic_submit: {},
    value_button: { optin: 0.05 },
    first_person: { optin: 0.06 },
    risk_reversal: { optin: 0.04, checkout: 0.02, refund: -0.005 },
  },
  form: {
    full_profile: { optin: -0.06, checkout: 0.02 },
    email_name: { optin: 0.03, checkout: 0.01 },
    email_only: { optin: 0.09 },
  },
  page_weight: {
    heavy_rich: { engageMobile: -0.08, engageDesktop: -0.02 },
    balanced: { engage: 0.02 },
    lean_fast: { engageMobile: 0.09, engageDesktop: 0.04 },
  },
  social_proof: {
    none: {},
    logos: { optin: 0.02, checkout: 0.01 },
    testimonials: { optin: 0.04, checkout: 0.03 },
    live_counter: { optin: 0.05, pressure: 0.4 },
  },
  offer_framing: {
    feature_list: {},
    outcome_promise: { checkout: 0.04 },
    guarantee_led: { checkout: 0.05, refund: -0.01 },
    anchored_discount: { checkout: 0.07, refund: 0.02, upsell: 0.02 },
  },
  checkout: {
    multi_step: { upsell: 0.03 },
    single_page: { checkout: 0.05 },
    express_wallet: { checkoutMobile: 0.09, checkoutDesktop: 0.05, upsell: -0.02 },
  },
  urgency: {
    none: {},
    honest_deadline: { checkout: 0.03, pressure: 0.3 },
    fake_countdown: { checkout: 0.09, pressure: 2.0, refund: 0.05, darkPattern: true },
  },
};

// Traffic segments: device × intent, each with its own base rates and CPC.
const SEGMENTS = {
  mobile_cold: { device: 'mobile', intent: 'cold', cpc: 0.62 },
  mobile_warm: { device: 'mobile', intent: 'warm', cpc: 0.85 },
  desktop_cold: { device: 'desktop', intent: 'cold', cpc: 0.95 },
  desktop_warm: { device: 'desktop', intent: 'warm', cpc: 1.2 },
};

const AOV = 59;          // average order value ($)
const UPSELL_VALUE = 34; // incremental upsell revenue ($)

/** The cohort the gate optimizes against (the holdout). */
export const HOLDOUT_COHORT = {
  id: 'holdout-blended-9k',
  seed: 424242,
  visitors: 9000,
  mix: { mobile_cold: 0.35, mobile_warm: 0.15, desktop_cold: 0.35, desktop_warm: 0.15 },
};

/** The FROZEN anchor: a mobile-heavy cohort the loop never optimizes against. */
export const ANCHOR_COHORT = {
  id: 'anchor-mobile-heavy-7k',
  seed: 777001,
  visitors: 7000,
  mix: { mobile_cold: 0.55, mobile_warm: 0.2, desktop_cold: 0.15, desktop_warm: 0.1 },
};

/** A smaller, differently-seeded cohort per generation for the proposer's quick A/B pass. */
export function explorationCohort(generation) {
  return {
    id: `explore-gen${generation}`,
    seed: 90210 + generation * 7919,
    visitors: 3000,
    mix: { mobile_cold: 0.4, mobile_warm: 0.1, desktop_cold: 0.4, desktop_warm: 0.1 },
  };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function policyHash(policy) {
  return fnv1a(Object.keys(policy).sort().map((k) => `${k}=${policy[k]}`).join('|'));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (p, lo = 0.02, hi = 0.95) => Math.min(hi, Math.max(lo, p));

/** Sum a named effect across every active lever value. */
function effectSum(policy, key) {
  let sum = 0;
  for (const [lever, value] of Object.entries(policy)) sum += EFFECTS[lever]?.[value]?.[key] ?? 0;
  return sum;
}

function usesDarkPattern(policy) {
  return Object.entries(policy).some(([lever, value]) => EFFECTS[lever]?.[value]?.darkPattern === true);
}

/** Per-segment stage probabilities for a policy. */
export function stageRates(policy, segment) {
  const { device, intent } = SEGMENTS[segment];
  const engage =
    (device === 'mobile' ? 0.40 : 0.50) + (intent === 'warm' ? 0.08 : 0) +
    effectSum(policy, 'engage') +
    (device === 'mobile' ? effectSum(policy, 'engageMobile') : effectSum(policy, 'engageDesktop')) +
    (intent === 'cold' ? effectSum(policy, 'engageCold') : effectSum(policy, 'engageWarm'));
  const optin = 0.22 + (intent === 'warm' ? 0.05 : 0) + effectSum(policy, 'optin');
  const checkout =
    0.15 + (intent === 'warm' ? 0.04 : 0) + effectSum(policy, 'checkout') +
    (device === 'mobile' ? effectSum(policy, 'checkoutMobile') : effectSum(policy, 'checkoutDesktop'));
  const upsell = 0.16 + effectSum(policy, 'upsell');
  const refund = 0.03 + effectSum(policy, 'refund') + 0.012 * effectSum(policy, 'pressure');
  return {
    engage: clamp(engage), optin: clamp(optin), checkout: clamp(checkout),
    upsell: clamp(upsell), refund: clamp(refund, 0.005, 0.5),
  };
}

/**
 * Simulate a cohort through the funnel under a policy. Deterministic in
 * (policy, cohort): the RNG is seeded from both.
 */
export function simulate(policy, cohort) {
  const rng = mulberry32((cohort.seed ^ policyHash(policy)) >>> 0);
  const totals = { visitors: 0, engaged: 0, optins: 0, purchases: 0, upsells: 0, refunds: 0, spend: 0 };

  for (const [segment, share] of Object.entries(cohort.mix)) {
    const n = Math.round(cohort.visitors * share);
    const r = stageRates(policy, segment);
    totals.visitors += n;
    totals.spend += n * SEGMENTS[segment].cpc;
    for (let i = 0; i < n; i++) {
      if (rng() >= r.engage) continue;
      totals.engaged++;
      if (rng() >= r.optin) continue;
      totals.optins++;
      if (rng() >= r.checkout) continue;
      totals.purchases++;
      if (rng() < r.upsell) totals.upsells++;
      if (rng() < r.refund) totals.refunds++;
    }
  }

  const netPurchases = totals.purchases - totals.refunds;
  const revenue = totals.purchases * AOV + totals.upsells * UPSELL_VALUE - totals.refunds * AOV;
  const refundRate = totals.purchases > 0 ? totals.refunds / totals.purchases : 0;
  return {
    ...totals,
    netPurchases,
    revenue: Math.round(revenue),
    bounceRate: 1 - totals.engaged / totals.visitors,
    cvr: netPurchases / totals.visitors,
    cac: totals.spend / Math.max(1, netPurchases),
    revenuePerVisitor: revenue / totals.visitors,
    roas: revenue / totals.spend,
    refundRate,
    darkPattern: usesDarkPattern(policy),
  };
}

/** Project a simulation onto the flywheel's four abstract Score axes. */
export function toScore(sim) {
  return {
    primary: sim.cvr,                 // end-to-end conversion rate (net of refunds)
    noopRate: sim.bounceRate,         // visitors who never engaged at all
    costPerWin: sim.cac,              // paid-traffic cost per net purchase
    regressed: sim.darkPattern || sim.refundRate > 0.09, // compliance hard stop
  };
}
