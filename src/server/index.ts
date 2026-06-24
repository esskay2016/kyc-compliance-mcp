// HTTP backend for the KYC agent UI.
//
// Exposes POST /api/screen — takes applicant form data, runs the real agentic pipeline
// (runScreeningAgentic: host-enforced sanctions -> Claude orchestrates tools -> validation
// -> audit log), and returns a response split into:
//   - visible:  decision, risk score, summary, and the tool-call SEQUENCE (names + order)
//   - gated:    detailed per-tool findings, override reasoning, and full audit trace
//               (the client only reveals these after the officer passcode is entered;
//                we also require the passcode on a second endpoint for true gating)
//
// The Anthropic API key lives ONLY here (process.env), never in the browser.

import express from "express";
import cors from "cors";
import { runScreeningAgentic, type Applicant } from "../host/orchestrator.js";
import { AuditLog } from "../host/audit.js";

const app = express();
app.use(cors());
app.use(express.json());

const OFFICER_PASSCODE = process.env.OFFICER_PASSCODE || "compliance2026";

// In-memory store of full results by caseId, so the gated detail can be fetched
// separately only with the passcode (the browser never receives gated data until then).
const resultStore = new Map<string, any>();

function buildApplicant(body: any): Applicant {
  const caseId = `CASE-${Date.now()}`;
  const type = body.type === "business" ? "business" : "personal";
  const names: string[] = [];
  if (type === "personal") {
    if (body.fullName) names.push(body.fullName);
  } else {
    if (body.companyName) names.push(body.companyName);
    if (body.owner1Name) names.push(body.owner1Name);
    if (body.owner2Name) names.push(body.owner2Name);
  }
  const countries: string[] = [];
  if (body.country) countries.push(body.country);
  if (body.owner1Country) countries.push(body.owner1Country);
  if (body.owner2Country) countries.push(body.owner2Country);

  return {
    caseId,
    type,
    names,
    companyName: body.companyName,
    industry: body.industry,
    naics: body.naics,
    state: body.state,
    countries: countries.length ? countries : undefined,
    ssn: body.ssn,
    driversLicense: body.driversLicense,
    address: body.address,
  };
}

app.post("/api/screen", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });
  }
  try {
    const applicant = buildApplicant(req.body || {});
    if (applicant.names.length === 0) {
      return res.status(400).json({ error: "Provide at least a name or company." });
    }

    // capture the tool-call sequence (names + order) for the visible timeline
    const toolSequence: { step: number; tool: string; by: "host" | "model" }[] = [];
    toolSequence.push({ step: 1, tool: "screen_sanctions", by: "host" }); // host-enforced first

    const audit = new AuditLog(`audit-${applicant.caseId}.jsonl`);
    const result = await runScreeningAgentic(applicant, audit, {
      apiKey,
      onStep: (m) => {
        const match = m.match(/Claude called:\s*(\w+)/);
        if (match) {
          toolSequence.push({ step: toolSequence.length + 1, tool: match[1], by: "model" });
        }
      },
    });

    // Visible section — safe to show anyone
    const visible = {
      caseId: applicant.caseId,
      decision: result.finalDecision,
      riskScore: result.validated.riskScore,
      summary: decisionSummary(result),
      overridden: result.validated.overridden,
      toolSequence,
    };

    // Gated section — only released with the passcode
    const gated = {
      facts: result.facts,
      modelDecision: result.validated.modelDecision,
      overrideReasons: result.validated.overrideReasons,
      auditTrace: result.auditTrace.map((e) => ({ seq: e.seq, type: e.type, timestamp: e.timestamp })),
      auditIntact: audit.verify().ok,
    };

    resultStore.set(applicant.caseId, gated);

    res.json({ visible });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Gated detail — requires the officer passcode. The browser calls this only after the
// user enters the code, so detailed findings never reach the client otherwise.
app.post("/api/detail", (req, res) => {
  const { caseId, passcode } = req.body || {};
  if (passcode !== OFFICER_PASSCODE) {
    return res.status(403).json({ error: "Incorrect passcode." });
  }
  const gated = resultStore.get(caseId);
  if (!gated) return res.status(404).json({ error: "Case not found." });
  res.json({ gated });
});

function decisionSummary(result: any): string {
  const d = result.finalDecision;
  if (d === "FAIL") return "Application failed screening. See detailed findings for the disqualifying factor.";
  if (d === "ESCALATE") return "Application requires manual review / enhanced due diligence before a decision.";
  return "Application cleared automated screening.";
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.error(`KYC backend listening on http://localhost:${PORT}`);
});
