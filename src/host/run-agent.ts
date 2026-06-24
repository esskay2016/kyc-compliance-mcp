// CLI runner for the KYC agent (Option B: Claude orchestrates).
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run agent -- <scenario>
//
// scenarios: clean-business, weapons, cannabis-ca, sanctioned, personal

import { runScreeningAgentic, type Applicant } from "./orchestrator.js";
import { AuditLog } from "./audit.js";

const SCENARIOS: Record<string, Applicant> = {
  "clean-business": {
    caseId: "CASE-CLEAN",
    type: "business",
    names: ["Acme Robotics Inc", "Jane Miller", "Robert Chen"],
    companyName: "Acme Robotics Inc",
    industry: "industrial robotics manufacturing",
    state: "CA",
    countries: ["United States", "United States"],
  },
  weapons: {
    caseId: "CASE-WEAPONS",
    type: "business",
    names: ["Frontier Arms LLC", "Tom Brady", "Bill Smith"],
    companyName: "Frontier Arms LLC",
    industry: "firearms and ammunition dealer",
    state: "TX",
    countries: ["United States", "United States"],
  },
  "cannabis-ca": {
    caseId: "CASE-CANNABIS",
    type: "business",
    names: ["Green Leaf Wellness LLC", "Maria Lopez", "David Kim"],
    companyName: "Green Leaf Wellness LLC",
    industry: "cannabis dispensary",
    state: "CA",
    countries: ["United States", "United States"],
  },
  sanctioned: {
    caseId: "CASE-SANCTIONED",
    type: "personal",
    names: ["Maria Garcia"],
    countries: ["United States"],
  },
  personal: {
    caseId: "CASE-PERSONAL",
    type: "personal",
    names: ["John Williams"],
    countries: ["United States"],
  },
};

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ERROR: set ANTHROPIC_API_KEY in your environment.");
    process.exit(1);
  }

  const which = process.argv[2] || "clean-business";
  const applicant = SCENARIOS[which];
  if (!applicant) {
    console.error(`Unknown scenario "${which}". Options: ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }

  console.log(`\n=== Running scenario: ${which} (${applicant.caseId}) — AGENTIC ===\n`);

  const audit = new AuditLog(`audit-${applicant.caseId}.jsonl`);
  const result = await runScreeningAgentic(applicant, audit, {
    apiKey,
    onStep: (m) => console.log("  ·", m),
  });

  console.log("\n--- FINAL DECISION ---");
  console.log("Decision:", result.finalDecision);
  console.log("Model said:", result.validated.modelDecision,
    result.validated.overridden ? "(OVERRIDDEN by guardrails)" : "");
  if (result.validated.overrideReasons.length) {
    console.log("Override reasons:");
    for (const r of result.validated.overrideReasons) console.log("   -", r);
  }
  console.log("Risk score:", result.validated.riskScore);

  console.log("\n--- FACTS CLAUDE GATHERED ---");
  console.log(JSON.stringify(result.facts, null, 2));

  console.log("\n--- AUDIT TRACE ---");
  for (const e of result.auditTrace) console.log(`  [${e.seq}] ${e.type}`);
  const v = audit.verify();
  console.log("\nAudit chain intact:", v.ok);
  console.log(`(full trace written to audit-${applicant.caseId}.jsonl)\n`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
