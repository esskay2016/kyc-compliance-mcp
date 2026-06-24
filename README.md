# KYC Compliance MCP Server

An **agentic KYC/AML compliance system** built on the Model Context Protocol (MCP). An MCP
server exposes compliance checks as tools, and an AI model (Claude) **decides which tools to
call and in what order** to perform customer due diligence — wrapped in a host layer that
enforces the legally non-negotiable checks, validates the model's decision, and writes a
tamper-evident audit log.

The point: the model does the *discretionary* investigation; deterministic code enforces the
*mandatory* controls and records everything. That hybrid — a reasoning core inside compliance
rails — is the difference between a demo and something defensible in a regulated setting.

> **Note:** this is a proof-of-concept for demonstrating MCP orchestration and compliance
> architecture, not a production compliance system. See *Notes / limitations* below — several
> data sources are deliberately stubbed as honest integration points because the real data is
> licensed or legally gated.

## Architecture

```
applicant ─► HOST: enforce mandatory sanctions screen (always runs)
                │
                ▼
            CLAUDE orchestrates the rest — picks tools, reads results, decides:
            verify_identity · assess_industry_risk · lookup_business ·
            screen_pep · assess_country_risk
                │
                ▼
            HOST: validate the model's decision against the gathered facts
                  (overrides can only make the outcome STRICTER, never looser)
                │
                ▼
            FINAL DECISION  +  hash-chained AUDIT LOG (tamper-evident)
```

The decision is one of **PASS** / **ESCALATE** / **FAIL**, where ESCALATE routes the case to a
human for enhanced due diligence — the honest posture for an AI first-pass triage tool.

## Risk score

Each result carries a **risk score from 0 to 10 where HIGHER means MORE risky** (this is the
opposite direction of a credit score, so it can be counterintuitive):

- **0–3** low risk — e.g. a clean standard-industry business with domestic owners
- **4–6** moderate risk — elevated factors present, warrants attention
- **7–10** high risk — a hard gate hit (sanctions, prohibited industry), failed identity
  validation, or high country risk

A low score does **not** guarantee a PASS: an unresolved integration-point check (e.g. PEP)
can still force an ESCALATE even at 2/10, because final clearance requires that check be
completed manually.

## Tools

| Tool | What it does | Backed by |
|---|---|---|
| `screen_sanctions` | Screens names against the live OFAC SDN list | treasury.gov OFAC SDN (live) |
| `verify_identity` | Structural SSN / driver's-license / address validation | SSA rules + state DL formats (live, no key) |
| `assess_country_risk` | 0–10 country risk score + band | World Bank indicators (+ proxy overrides) |
| `lookup_business` | Verifies a company is an SEC-registered filer | SEC EDGAR (live, no key) |
| `assess_industry_risk` | PROHIBITED / STATE_CONDITIONAL / ELEVATED / STANDARD | NAICS-keyed rules (built in) |
| `screen_pep` | Politically Exposed Person screening | Integration-point stub (see caveats) |

The industry tool encodes real regulatory nuance: weapons are a hard gate; cannabis is
**state-conditional** (legal-program states → escalate for enhanced due diligence; non-program
states → decline); crypto, gambling, cash-intensive, etc. are elevated-risk inputs the model
weighs.

## Why this is an MCP showcase

The model orchestrates the calls. Given a business applicant it will typically call
`assess_industry_risk` first (a PROHIBITED result can short-circuit to FAIL), then
`screen_sanctions` on the company and each owner, `lookup_business` to verify the entity, and
`assess_country_risk` on any non-US owner. For a personal applicant it calls `verify_identity`
and `screen_pep`. That orchestration is the model's, not the code's — which is what
distinguishes MCP from a fixed serverless pipeline.

## Web UI

A React UI (`ui/`) drives the agent over an Express backend. It shows the **decision** and the
**tool-call sequence** ("how the agent investigated") to anyone, while **detailed findings and
the audit trace are officer-gated** behind a passcode — demonstrating both the orchestration
and an access-control boundary. See `UI_SETUP.md` to run it.


## Run it

```bash
npm install
npm run build
```

### Test with the MCP Inspector (recommended first step)

```bash
npm run inspect
```

This opens the Inspector UI (port 6274). You can fire each tool manually and watch the
raw JSON-RPC traffic — the fastest way to confirm the tools work before wiring a host.

### Wire into Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kyc-compliance": {
      "command": "node",
      "args": ["/absolute/path/to/kyc-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop, then ask it to "run KYC due diligence on Acme LLC, a firearms
retailer in Texas with owners Jane Doe and John Roe" — it will discover and call the tools.

## Compliance guardrails (the host layer)

"The model decides which tools to call" is great for capability but unacceptable on its
own in a regulated setting — a missed sanctions check is a violation, not a bug. The
`src/host/` layer wraps the model so it reasons *inside* deterministic rails:

- **Mandatory-screening enforcement** (`orchestrator.ts`) — sanctions screening (and, for
  businesses, industry classification) always run, executed by the host, regardless of
  whether the model would have chosen to call them. The model never gets to skip a
  required check.
- **Output validation** (`validation.ts`) — the model's PASS/FAIL/ESCALATE is checked
  against the hard screening facts. A potential OFAC match or a PROHIBITED industry forces
  FAIL even if the model said PASS; a state-conditional industry or high country risk forces
  at least ESCALATE. Overrides only ever make the outcome *stricter*, never looser.
- **Hash-chained audit log** (`audit.ts`) — every request, tool call, tool result, model
  decision, override, and final decision is written to an append-only, SHA-256 hash-chained
  log. Editing any past entry breaks the chain and is detectable — this is what you hand an
  examiner to reconstruct why any customer was approved or declined.

The division of labor: **the model orchestrates the discretionary analysis; the code
enforces the non-negotiable checks and records everything.** That hybrid — reasoning core,
deterministic guardrails — is the difference between a demo and a system you could defend
in a compliance review.

## Screenshots

**Clean business applicant (PASS):** All checks pass; decision is PASS at 3/10 risk. Escalation due to lack of PEP integration. 
<img width="1266" height="856" alt="Pass Clean Business" src="https://github.com/user-attachments/assets/0271baa6-c9d3-4c17-9269-67be8dac85c7" />
<img width="1069" height="854" alt="Pass Clean_Details" src="https://github.com/user-attachments/assets/d0754ae6-bc7f-4a0d-98c9-759f0e7e7b6d" />

**State-conditional industry (ESCALATE):** Cannabis in California triggers state-conditional escalation for enhanced due diligence.
<img width="895" height="855" alt="Escalate State Condl Business" src="https://github.com/user-attachments/assets/5b31ccb3-75d2-40e3-8cdb-8c19cc4c32e2" />

**Prohibited industry (FAIL):** Weapons dealer hard-gate; decision is FAIL at 10/10 risk.
<img width="1252" height="819" alt="Fail Prohibited Business" src="https://github.com/user-attachments/assets/ec83c72b-41f0-4e71-bff2-c178ff064cda" />

**Officer-gated findings:** Detailed per-tool findings and audit trace are revealed only after entering the passcode.
<img width="979" height="851" alt="Gated Detail with PEP person" src="https://github.com/user-attachments/assets/efda214a-0728-480f-9516-72f974b57525" />


## Notes / limitations (good to be honest about in interviews)

- **Sanctions matching is simple** (token match, not fuzzy/phonetic). Real screening adds
  secondary identifiers (DOB, nationality) to cut false positives. The architecture — live
  government data driving the decision — is the point. (You'll see common names like
  "Maria Garcia" produce false-positive potential matches; the system fails safe by
  escalating, which is the correct direction.)
- **Country risk** uses a small override table plus a World Bank indicator fallback, as a
  public proxy for a licensed country-risk feed. The country-name→ISO lookup is thin;
  passing ISO-2 codes (e.g. "BR") is most reliable.
- **Business lookup covers SEC filers only.** `lookup_business` uses SEC EDGAR (free, no
  key), which only contains public / SEC-registered companies. A no-match is EXPECTED for
  most small private LLCs and is NOT disqualifying — the tool says so in its note. Full
  private-entity coverage requires OpenCorporates (paid) or per-state Secretary-of-State
  integration (California has a key-gated API; Delaware is CAPTCHA-protected with paywalled
  status). Those are defined as production integration points, not built here.
- **Identity verification is structural only.** `verify_identity` validates SSN format/range
  (SSA rules), driver's-license format per state, and address presence — it catches fabricated
  or malformed identifiers, but does NOT confirm they belong to the person. Authoritative match
  (SSN-to-name via SSA eCBSV, DL-to-record via AAMVA/DMV) is legally gated to permitted entities
  with consumer consent, so it's a documented production integration point.
- **PEP screening is an integration point, not live.** `screen_pep` returns an
  INTEGRATION_POINT status, not a clean result. Credible PEP data is licensed —
  OpenSanctions has strong PEP coverage but its API requires a key/commercial license, and
  World-Check / Dow Jones / LexisNexis are commercial. PEP is a required KYC control, so the
  tool seam is built and the model is told to treat the result as "manual EDD required"
  rather than "no PEP found." Production supplies provider credentials.

## Roadmap

- Wire EU/UK consolidated lists into `screen_sanctions` (the parameter already exists)
- Fuzzy name matching with secondary identifiers
- A thin host backend + the existing React UI as the front end
