// Host orchestrator.
//
// This is the layer that makes the agent safe to run in a compliance setting.
// It does three things the model is NOT allowed to do on its own:
//   1. ENFORCE mandatory screening — sanctions + industry always run, regardless of
//      whether the model would have "chosen" to call them.
//   2. VALIDATE the model's decision against those screening facts and override on conflict.
//   3. AUDIT every step into a hash-chained log that can be handed to an examiner.
//
// The model still does the discretionary reasoning (weighing factors, drafting the
// rationale), but it reasons INSIDE these rails — it cannot skip a required check and
// cannot overturn a hard rule.

import { AuditLog } from "./audit.js";
import { validateDecision, type ModelDecision, type ScreeningFacts, type ValidatedDecision } from "./validation.js";
import { screenSanctions, assessCountryRisk } from "../datasources.js";
import { assessIndustry } from "../industry.js";

export interface Applicant {
  caseId: string;
  type: "personal" | "business";
  names: string[];        // applicant + any beneficial owners
  companyName?: string;
  industry?: string;
  naics?: string;
  state?: string;
  countries?: string[];   // applicant + owner countries
  ssn?: string;
  driversLicense?: string;
  address?: string;
}

// A stand-in for the model call. In production this is the Anthropic API tool-use loop;
// here it's injected so the orchestration + guardrails can be tested deterministically.
export type ModelFn = (
  applicant: Applicant,
  facts: ScreeningFacts
) => Promise<ModelDecision>;

export interface ScreeningResult {
  caseId: string;
  finalDecision: ValidatedDecision["finalDecision"];
  validated: ValidatedDecision;
  facts: ScreeningFacts;
  auditTrace: ReturnType<AuditLog["trace"]>;
}

export async function runScreening(
  applicant: Applicant,
  model: ModelFn,
  audit: AuditLog
): Promise<ScreeningResult> {
  const { caseId } = applicant;
  audit.record(caseId, "SCREENING_REQUESTED", {
    type: applicant.type,
    names: applicant.names,
    industry: applicant.industry,
    state: applicant.state,
  });

  // ---- 1. MANDATORY: sanctions screening on every name. Not optional, not the model's call. ----
  audit.record(caseId, "MANDATORY_CHECK_ENFORCED", { check: "screen_sanctions", reason: "Required on every applicant and beneficial owner." });
  audit.record(caseId, "TOOL_CALLED", { tool: "screen_sanctions", input: { names: applicant.names } });
  const sanctions = await screenSanctions(applicant.names);
  audit.record(caseId, "TOOL_RESULT", { tool: "screen_sanctions", result: sanctions });

  // ---- 2. MANDATORY for business: industry classification (carries the hard gates). ----
  let industry: ScreeningFacts["industry"] = null;
  if (applicant.type === "business" && applicant.industry) {
    audit.record(caseId, "MANDATORY_CHECK_ENFORCED", { check: "assess_industry_risk", reason: "Required for business applicants — carries prohibited-industry hard gate." });
    audit.record(caseId, "TOOL_CALLED", { tool: "assess_industry_risk", input: { industry: applicant.industry, naics: applicant.naics, state: applicant.state } });
    const ind = assessIndustry(applicant.industry, applicant.naics, applicant.state);
    audit.record(caseId, "TOOL_RESULT", { tool: "assess_industry_risk", result: ind });
    industry = { classification: ind.classification, category: ind.category };
  }

  // ---- 3. Country risk on each provided country (mandatory where a country is given). ----
  const countryRisk: NonNullable<ScreeningFacts["countryRisk"]> = [];
  for (const c of applicant.countries || []) {
    audit.record(caseId, "TOOL_CALLED", { tool: "assess_country_risk", input: { country: c } });
    const cr = await assessCountryRisk(c);
    audit.record(caseId, "TOOL_RESULT", { tool: "assess_country_risk", result: cr });
    countryRisk.push({ riskScore: cr.riskScore, band: cr.band });
  }

  const facts: ScreeningFacts = {
    sanctions: sanctions.results.map((r) => ({ name: r.name, potentialMatch: r.potentialMatch })),
    industry,
    countryRisk: countryRisk.length ? countryRisk : null,
  };

  // ---- 4. Model reasons over the enforced facts (discretionary layer). ----
  const modelDecision = await model(applicant, facts);
  audit.record(caseId, "MODEL_DECISION", { ...modelDecision });

  // ---- 5. Validate model output against the hard facts; override on conflict. ----
  const validated = validateDecision(modelDecision, facts);
  audit.record(caseId, "OUTPUT_VALIDATION", {
    modelDecision: validated.modelDecision,
    finalDecision: validated.finalDecision,
    overridden: validated.overridden,
  });
  if (validated.overridden) {
    audit.record(caseId, "DECISION_OVERRIDDEN", { reasons: validated.overrideReasons });
  }

  audit.record(caseId, "FINAL_DECISION", {
    decision: validated.finalDecision,
    riskScore: validated.riskScore,
  });

  return {
    caseId,
    finalDecision: validated.finalDecision,
    validated,
    facts,
    auditTrace: audit.trace(caseId),
  };
}

// ---- Option B: Claude orchestrates. Host enforces ONLY sanctions, then validates. ----
import { runClaudeAgent, type AgentOptions } from "./agent.js";
import { screenSanctions as _screenSanctions } from "../datasources.js";

export async function runScreeningAgentic(
  applicant: Applicant,
  audit: AuditLog,
  agentOpts: AgentOptions
): Promise<ScreeningResult> {
  const { caseId } = applicant;
  audit.record(caseId, "SCREENING_REQUESTED", {
    type: applicant.type,
    names: applicant.names,
    industry: applicant.industry,
    state: applicant.state,
    mode: "agentic",
  });

  // The ONLY host-enforced check: sanctions. Legally non-skippable.
  audit.record(caseId, "MANDATORY_CHECK_ENFORCED", { check: "screen_sanctions", reason: "Legally required; enforced by host before model orchestration." });
  audit.record(caseId, "TOOL_CALLED", { tool: "screen_sanctions", input: { names: applicant.names }, by: "host" });
  const sanctions = await _screenSanctions(applicant.names);
  audit.record(caseId, "TOOL_RESULT", { tool: "screen_sanctions", result: sanctions, by: "host" });
  const enforcedSanctions = sanctions.results.map((r) => ({ name: r.name, potentialMatch: r.potentialMatch }));

  // Claude now orchestrates the rest, calling tools itself.
  audit.record(caseId, "MODEL_ORCHESTRATION_START", {});
  const agent = await runClaudeAgent(applicant, enforcedSanctions, {
    ...agentOpts,
    onStep: (m) => {
      agentOpts.onStep?.(m);
      // log each Claude-initiated tool call into the audit trail
      if (m.startsWith("Claude called:")) {
        audit.record(caseId, "TOOL_CALLED", { detail: m, by: "model" });
      }
    },
  });
  audit.record(caseId, "MODEL_DECISION", { ...agent.decision, toolCallsByModel: agent.toolCallCount });

  // Validate Claude's decision against the facts Claude actually gathered.
  const validated = validateDecision(agent.decision, agent.facts);
  audit.record(caseId, "OUTPUT_VALIDATION", {
    modelDecision: validated.modelDecision,
    finalDecision: validated.finalDecision,
    overridden: validated.overridden,
  });
  if (validated.overridden) {
    audit.record(caseId, "DECISION_OVERRIDDEN", { reasons: validated.overrideReasons });
  }

  audit.record(caseId, "FINAL_DECISION", { decision: validated.finalDecision, riskScore: validated.riskScore });

  return {
    caseId,
    finalDecision: validated.finalDecision,
    validated,
    facts: agent.facts,
    auditTrace: audit.trace(caseId),
  };
}
