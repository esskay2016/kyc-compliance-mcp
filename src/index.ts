#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { screenSanctions, assessCountryRisk, lookupBusiness, screenPEP } from "./datasources.js";
import { assessIndustry } from "./industry.js";
import { verifyIdentity } from "./identity.js";

const server = new McpServer({
  name: "kyc-compliance-mcp",
  version: "1.0.0",
});

// ---- Tool 1: sanctions screening (OFAC SDN) ----
server.registerTool(
  "screen_sanctions",
  {
    description:
      "Screen one or more individual or entity names against the live OFAC SDN " +
      "sanctions list. Call this for every applicant, every beneficial owner, and " +
      "every company name. A potential match must be treated as disqualifying " +
      "(FAIL) pending human review.",
    inputSchema: {
      names: z
        .array(z.string())
        .describe("Full names to screen: applicant, each beneficial owner, and company."),
      extraLists: z
        .array(z.string())
        .optional()
        .describe("Optional additional lists requested, e.g. 'EU Consolidated', 'UK Sanctions'."),
    },
  },
  async ({ names, extraLists }) => {
    const out = await screenSanctions(names, extraLists || []);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// ---- Tool 2: country risk (World Bank proxy) ----
server.registerTool(
  "assess_country_risk",
  {
    description:
      "Assess AML/sanctions country risk for a given country (name or ISO-2 code), " +
      "returning a 0-10 risk score and band. Call for the applicant's country and for " +
      "any beneficial owner whose country differs. Score >= 7 should drive ESCALATE.",
    inputSchema: {
      country: z.string().describe("Country name or ISO-2 code, e.g. 'United States' or 'US'."),
    },
  },
  async ({ country }) => {
    const out = await assessCountryRisk(country);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// ---- Tool 3: business registry lookup (OpenCorporates) ----
server.registerTool(
  "lookup_business",
  {
    description:
      "Look up a business entity in the SEC EDGAR registry to verify it is a real, " +
      "SEC-registered filer. Call for any business applicant. Note: only public/SEC-" +
      "registered companies appear — a no-match is expected for small private LLCs and " +
      "is NOT itself disqualifying, but an applicant claiming to be a public company with " +
      "no EDGAR match is a red flag worth ESCALATE.",
    inputSchema: {
      companyName: z.string().describe("Legal company name to search."),
      jurisdiction: z
        .string()
        .optional()
        .describe("Optional; not used for EDGAR (kept for interface compatibility)."),
    },
  },
  async ({ companyName, jurisdiction }) => {
    const out = await lookupBusiness(companyName, jurisdiction);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// ---- Tool 4: industry risk (NAICS hard-gate / soft-risk / state-conditional) ----
server.registerTool(
  "assess_industry_risk",
  {
    description:
      "Classify a business industry for AML risk. Returns one of PROHIBITED (hard gate — " +
      "decision must be FAIL), STATE_CONDITIONAL (e.g. cannabis — legality depends on state, " +
      "drive ESCALATE), ELEVATED (allowed with enhanced due diligence), or STANDARD. Call for " +
      "every business applicant. Pass the state so cannabis can be resolved correctly.",
    inputSchema: {
      industry: z.string().describe("Free-text industry description, e.g. 'firearms retailer'."),
      naics: z.string().optional().describe("Optional NAICS code if known."),
      state: z
        .string()
        .optional()
        .describe("US state of operation (2-letter), needed to resolve state-conditional industries."),
    },
  },
  async ({ industry, naics, state }) => {
    const out = assessIndustry(industry, naics, state);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// ---- Tool 5: PEP screening (integration-point stub) ----
server.registerTool(
  "screen_pep",
  {
    description:
      "Screen names for Politically Exposed Person (PEP) status. NOTE: this is an integration " +
      "point — credible PEP data is licensed (OpenSanctions key/license, World-Check, Dow Jones). " +
      "It returns a defined-but-not-live status, NOT a clean result. A returned status of " +
      "INTEGRATION_POINT means PEP screening must be completed manually as an enhanced-due-diligence " +
      "step; do not treat it as 'no PEP found'.",
    inputSchema: {
      names: z.array(z.string()).describe("Names to screen for PEP status."),
    },
  },
  async ({ names }) => {
    const out = await screenPEP(names);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

// ---- Tool 6: identity verification (structural validation + integration point) ----
server.registerTool(
  "verify_identity",
  {
    description:
      "Validate a personal applicant's identity documents structurally: SSN format/range " +
      "(SSA rules), driver's-license format for the claimed state, and address presence. " +
      "Returns VALID_FORMAT / INVALID_FORMAT / SUSPICIOUS / INSUFFICIENT_DATA. NOTE: this is " +
      "structural validation only — it does NOT confirm the identifiers belong to the person " +
      "(authoritative SSA/DMV match is a gated integration point). INVALID_FORMAT is a red flag.",
    inputSchema: {
      ssn: z.string().optional().describe("SSN (any format; digits extracted)."),
      driversLicense: z.string().optional().describe("Driver's license number."),
      state: z.string().optional().describe("US state (2-letter) for DL format rules."),
      address: z.string().optional().describe("Residential address."),
    },
  },
  async ({ ssn, driversLicense, state, address }) => {
    const out = verifyIdentity({ ssn, driversLicense, state, address });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — never stdout, which carries the JSON-RPC protocol
  console.error("KYC Compliance MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
