// Claude-backed agent — Option B: Claude orchestrates the tools.
//
// Division of labor:
//   - The HOST enforces only the one legally non-skippable check up front: sanctions.
//     That result is injected so Claude cannot avoid it.
//   - CLAUDE orchestrates everything else — it decides to call assess_industry_risk,
//     lookup_business, assess_country_risk, in whatever order, reading each result before
//     the next. This is the genuine MCP-style orchestration.
//   - As Claude calls tools, the host CAPTURES the results into a facts object, so the
//     guardrail/validation layer afterward has the data to override a bad final decision
//     (e.g. Claude forgets industry on a weapons dealer -> validation still catches it).

import { screenSanctions, assessCountryRisk, lookupBusiness, screenPEP } from "../datasources.js";
import { assessIndustry } from "../industry.js";
import { verifyIdentity } from "../identity.js";
import type { Applicant } from "./orchestrator.js";
import type { ModelDecision, ScreeningFacts } from "./validation.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

const TOOLS = [
  {
    name: "screen_sanctions",
    description:
      "Screen names against the live OFAC SDN sanctions list. A potential match must be " +
      "treated as disqualifying (FAIL) pending human review.",
    input_schema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "Names to screen." } },
      required: ["names"],
    },
  },
  {
    name: "assess_country_risk",
    description: "Assess AML/sanctions country risk (0-10). Score >= 7 should drive ESCALATE.",
    input_schema: {
      type: "object",
      properties: { country: { type: "string", description: "Country name or ISO-2 code." } },
      required: ["country"],
    },
  },
  {
    name: "lookup_business",
    description:
      "Verify a business in SEC EDGAR. No-match is expected for small private LLCs and is " +
      "not itself disqualifying; a public-company claim with no match is a red flag.",
    input_schema: {
      type: "object",
      properties: { companyName: { type: "string", description: "Legal company name." } },
      required: ["companyName"],
    },
  },
  {
    name: "assess_industry_risk",
    description:
      "Classify a business industry: PROHIBITED (hard gate -> FAIL), STATE_CONDITIONAL " +
      "(e.g. cannabis -> ESCALATE), ELEVATED (enhanced due diligence), or STANDARD.",
    input_schema: {
      type: "object",
      properties: {
        industry: { type: "string", description: "Industry description." },
        naics: { type: "string", description: "Optional NAICS code." },
        state: { type: "string", description: "US state (2-letter) for state-conditional industries." },
      },
      required: ["industry"],
    },
  },
  {
    name: "screen_pep",
    description:
      "Screen names for Politically Exposed Person status. NOTE: integration point — returns a " +
      "not-live status (INTEGRATION_POINT), not a clean result. If status is INTEGRATION_POINT, " +
      "note that PEP screening requires manual EDD and factor that into your summary; do not treat " +
      "it as 'no PEP found'.",
    input_schema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" }, description: "Names to screen for PEP status." } },
      required: ["names"],
    },
  },
  {
    name: "verify_identity",
    description:
      "Validate a PERSONAL applicant's identity documents structurally: SSN format/range, " +
      "driver's-license format for the state, address presence. Returns VALID_FORMAT / " +
      "INVALID_FORMAT / INSUFFICIENT_DATA. Structural only — authoritative SSA/DMV match is a " +
      "gated integration point. INVALID_FORMAT is a red flag worth ESCALATE or FAIL. Call this " +
      "for personal applicants when identity fields are provided.",
    input_schema: {
      type: "object",
      properties: {
        ssn: { type: "string", description: "SSN." },
        driversLicense: { type: "string", description: "Driver's license number." },
        state: { type: "string", description: "US state (2-letter)." },
        address: { type: "string", description: "Residential address." },
      },
    },
  },
];

interface CapturedFacts {
  sanctions: { name: string; potentialMatch: boolean }[];
  industry: { classification: string; category: string } | null;
  countryRisk: { riskScore: number; band: string }[];
  identity: { verdict: string } | null;
  pepStatus: "RESOLVED" | "INTEGRATION_POINT" | null;
}

async function runTool(name: string, input: any, captured: CapturedFacts): Promise<string> {
  switch (name) {
    case "screen_sanctions": {
      const out = await screenSanctions(input.names || []);
      for (const r of out.results) {
        // dedupe: don't add a name we've already captured (host pre-screen + model re-screen)
        const exists = captured.sanctions.some(
          (s) => s.name.toLowerCase() === r.name.toLowerCase()
        );
        if (!exists) captured.sanctions.push({ name: r.name, potentialMatch: r.potentialMatch });
      }
      return JSON.stringify(out);
    }
    case "assess_country_risk": {
      const out = await assessCountryRisk(input.country || "");
      captured.countryRisk.push({ riskScore: out.riskScore, band: out.band });
      return JSON.stringify(out);
    }
    case "lookup_business":
      return JSON.stringify(await lookupBusiness(input.companyName || ""));
    case "assess_industry_risk": {
      const out = assessIndustry(input.industry || "", input.naics, input.state);
      captured.industry = { classification: out.classification, category: out.category };
      return JSON.stringify(out);
    }
    case "screen_pep": {
      const out = await screenPEP(input.names || []);
      captured.pepStatus = out.status === "INTEGRATION_POINT" ? "INTEGRATION_POINT" : "RESOLVED";
      return JSON.stringify(out);
    }
    case "verify_identity": {
      const out = verifyIdentity({
        ssn: input.ssn,
        driversLicense: input.driversLicense,
        state: input.state,
        address: input.address,
      });
      captured.identity = { verdict: out.verdict };
      return JSON.stringify(out);
    }
    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

const SYSTEM = `You are a US KYC/AML compliance officer performing customer due diligence.
You ORCHESTRATE the investigation by calling tools yourself. Decide which to call and in
what order based on the applicant.

A sound order for a business applicant:
1. assess_industry_risk (a PROHIBITED result is a hard FAIL — you can stop early).
2. screen_sanctions on the company AND every beneficial owner.
3. lookup_business to verify the entity.
4. assess_country_risk for any non-US party.

For a personal applicant: call verify_identity if SSN / driver's license / address are
provided (INVALID_FORMAT is a red flag), screen_sanctions on the person, screen_pep, and
assess_country_risk if a non-US country is involved.

Decision rules:
- Any potential OFAC sanctions match => FAIL.
- PROHIBITED industry => FAIL.
- STATE_CONDITIONAL industry (e.g. cannabis) => ESCALATE.
- Country risk >= 7 => at least ESCALATE.
- Otherwise weigh the findings and decide.

You have been given the result of an initial mandatory sanctions screen. You may rely on it,
but you must still call any OTHER tools you need before deciding.

When done, output your FINAL decision as ONLY a single JSON object on its own, with NO other
text, NO markdown, NO backticks, NO explanation before or after:
{"decision":"PASS"|"FAIL"|"ESCALATE","riskScore":<0-10 integer>,"summary":"<1-2 sentences, no sensitive PII>"}`;

async function callAnthropic(messages: any[], apiKey: string): Promise<any> {
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || "Anthropic API error");
  return data;
}

function extractDecision(text: string): ModelDecision | null {
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    const p = JSON.parse(cleaned);
    if (p && p.decision) return { decision: p.decision, riskScore: p.riskScore ?? 5, summary: p.summary ?? "" };
  } catch { /* fall through */ }
  const matches = cleaned.match(/\{[^{}]*"decision"[^{}]*\}/g);
  if (matches && matches.length) {
    try {
      const p = JSON.parse(matches[matches.length - 1]);
      if (p && p.decision) return { decision: p.decision, riskScore: p.riskScore ?? 5, summary: p.summary ?? "" };
    } catch { /* fall through */ }
  }
  return null;
}

export interface AgentOptions {
  apiKey: string;
  onStep?: (msg: string) => void;
}

export interface AgentResult {
  decision: ModelDecision;
  facts: ScreeningFacts;
  toolCallCount: number;
}

export async function runClaudeAgent(
  applicant: Applicant,
  enforcedSanctions: ScreeningFacts["sanctions"],
  opts: AgentOptions
): Promise<AgentResult> {
  const { apiKey, onStep } = opts;

  const captured: CapturedFacts = {
    sanctions: [...enforcedSanctions],
    industry: null,
    countryRisk: [],
    identity: null,
    pepStatus: null,
  };

  const messages: any[] = [
    {
      role: "user",
      content:
        `Perform KYC due diligence on this applicant by calling the tools you need.\n\n` +
        `Applicant:\n${JSON.stringify(applicant, null, 2)}\n\n` +
        `Initial mandatory sanctions screen (already run by the host):\n` +
        `${JSON.stringify(enforcedSanctions, null, 2)}`,
    },
  ];

  let toolCallCount = 0;
  const MAX_TURNS = 10;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const data = await callAnthropic(messages, apiKey);
    messages.push({ role: "assistant", content: data.content });

    const toolUses = (data.content || []).filter((b: any) => b.type === "tool_use");

    if (toolUses.length === 0) {
      const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
      const decision = extractDecision(text);
      if (decision) {
        return {
          decision,
          facts: {
            sanctions: captured.sanctions,
            industry: captured.industry,
            countryRisk: captured.countryRisk.length ? captured.countryRisk : null,
            identity: captured.identity,
            pepStatus: captured.pepStatus,
          },
          toolCallCount,
        };
      }
      onStep?.("No parseable decision; asking model to restate as JSON.");
      messages.push({ role: "user", content: "Respond with ONLY the JSON decision object, nothing else." });
      continue;
    }

    const toolResults: any[] = [];
    for (const tu of toolUses) {
      toolCallCount++;
      onStep?.(`Claude called: ${tu.name}(${JSON.stringify(tu.input)})`);
      const result = await runTool(tu.name, tu.input, captured);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  onStep?.("Max turns reached; failing safe to ESCALATE.");
  return {
    decision: { decision: "ESCALATE", riskScore: 5, summary: "Tool loop did not converge; manual review required." },
    facts: {
      sanctions: captured.sanctions,
      industry: captured.industry,
      countryRisk: captured.countryRisk.length ? captured.countryRisk : null,
            identity: captured.identity,
            pepStatus: captured.pepStatus,
    },
    toolCallCount,
  };
}
