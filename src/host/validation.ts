// Output validation.
//
// The model produces a decision (PASS / FAIL / ESCALATE). We do NOT trust it blindly.
// We check it against the hard facts the deterministic screening produced, and override
// when the model's conclusion contradicts a non-negotiable rule.
//
// This is the safety net: even if the model reasons poorly or hallucinates a clean
// result, a real sanctions hit or a prohibited industry cannot pass.

export type Decision = "PASS" | "FAIL" | "ESCALATE";

export interface ScreeningFacts {
  sanctions: { name: string; potentialMatch: boolean }[];
  industry?: { classification: string; category: string } | null;
  countryRisk?: { riskScore: number; band: string }[] | null;
  identity?: { verdict: string } | null;
  pepStatus?: "RESOLVED" | "INTEGRATION_POINT" | null;
}

export interface ModelDecision {
  decision: Decision;
  riskScore: number;
  summary: string;
}

export interface ValidatedDecision {
  finalDecision: Decision;
  modelDecision: Decision;
  overridden: boolean;
  overrideReasons: string[];
  riskScore: number;
}

// Severity order so an override only ever makes the outcome stricter, never looser.
const SEVERITY: Record<Decision, number> = { PASS: 0, ESCALATE: 1, FAIL: 2 };

export function validateDecision(
  model: ModelDecision,
  facts: ScreeningFacts
): ValidatedDecision {
  const reasons: string[] = [];
  let enforced: Decision = model.decision;

  const escalate = (why: string) => {
    if (SEVERITY["ESCALATE"] > SEVERITY[enforced]) enforced = "ESCALATE";
    reasons.push(why);
  };
  const fail = (why: string) => {
    enforced = "FAIL";
    reasons.push(why);
  };

  // RULE 1 — any potential sanctions match forces FAIL, no matter what the model said.
  const sanctionsHit = facts.sanctions.filter((s) => s.potentialMatch);
  if (sanctionsHit.length > 0) {
    if (model.decision !== "FAIL") {
      fail(
        `Potential OFAC match on ${sanctionsHit
          .map((s) => s.name)
          .join(", ")} — model said ${model.decision}; enforced FAIL.`
      );
    }
  }

  // RULE 2 — a PROHIBITED industry is a hard gate => FAIL.
  if (facts.industry?.classification === "PROHIBITED") {
    if (model.decision !== "FAIL") {
      fail(
        `Industry "${facts.industry.category}" is PROHIBITED — model said ${model.decision}; enforced FAIL.`
      );
    }
  }

  // RULE 3 — STATE_CONDITIONAL (e.g. cannabis) must never silently PASS => at least ESCALATE.
  if (facts.industry?.classification === "STATE_CONDITIONAL") {
    if (model.decision === "PASS") {
      escalate(
        `Industry "${facts.industry.category}" is state-conditional — model said PASS; enforced ESCALATE for human review.`
      );
    }
  }

  // RULE 4 — high country risk must never silently PASS => at least ESCALATE.
  const highRisk = (facts.countryRisk || []).filter((c) => c.riskScore >= 7);
  if (highRisk.length > 0 && model.decision === "PASS") {
    escalate(
      `Country risk >= 7 detected — model said PASS; enforced ESCALATE.`
    );
  }

  // RULE 5 — identity structural validation failed => at least ESCALATE.
  if (facts.identity?.verdict === "INVALID_FORMAT" && model.decision === "PASS") {
    escalate(
      `Identity documents failed structural validation — model said PASS; enforced ESCALATE.`
    );
  }

  // RULE 6 — PEP consistency. PEP screening is an integration-point stub: it can never
  // return "clear", so a clean PASS is not achievable until PEP is completed manually.
  // Applied uniformly (personal AND business) so the stub's effect is consistent, fixing
  // the inconsistency where some cases PASSed and others ESCALATEd on the same stub.
  // If everything else is green and the model wants to PASS, cap at ESCALATE with reason.
  const pepUnresolved = facts.pepStatus === "INTEGRATION_POINT";
  if (pepUnresolved && model.decision === "PASS") {
    escalate(
      "PEP screening is an integration point and could not be completed automatically — " +
      "all other checks passed, but final clearance requires manual PEP completion; enforced ESCALATE."
    );
  }

  return {
    finalDecision: enforced,
    modelDecision: model.decision,
    overridden: enforced !== model.decision,
    overrideReasons: reasons,
    riskScore: model.riskScore,
  };
}
