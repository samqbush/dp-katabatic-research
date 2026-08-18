/**
 * Version identifiers for the katabatic call pipeline.
 *
 * WHY THIS EXISTS: §7's reproducibility requirement and the plan behind this file both depend on
 * being able to say, for any row in the prediction log, exactly which feature calculation, which
 * rule, and which label definition produced it. Without that, "improving" the rule silently
 * rewrites the meaning of every historical row that used the old one.
 *
 * `call-rule-v1` / `features-v1` are FROZEN. `scripts/lib/call-rule.mjs` must never change its
 * numeric behavior once tagged with these constants — if you need different behavior, add a new
 * version (v2, v3, ...) in a new module and leave v1 alone. This is what lets the v1 backtest
 * numbers already in research/katabatic-prediction.md keep meaning what they said.
 */

export const FEATURE_VERSION_V1 = 'features-v1';
export const RULE_VERSION_V1 = 'call-rule-v1';

export const FEATURE_VERSION_V2 = 'features-v2';
export const RULE_VERSION_V2 = 'call-rule-v2';

// The label definition has not changed as part of this work — it stays at v1 (§7 rule 1: a
// changed label requires a new name, not a silent edit). Recorded explicitly anyway so every log
// row is fully self-describing without cross-referencing code history.
export const LABEL_VERSION_V1 = 'label-v1';

// Pre-refactor live rows (written before this log gained version columns) cannot be assumed to
// match either v1 or v2 feature math — the live script had its own separately-drifted
// implementation. Tag them explicitly rather than pretending they are comparable to either.
export const LEGACY_VERSION = 'legacy';
