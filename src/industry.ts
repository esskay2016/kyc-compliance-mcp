// Industry risk classification for KYC/AML, keyed loosely by NAICS prefix or keyword.
// Three buckets:
//   - PROHIBITED: hard gate. Tool reports this and the decision must be FAIL.
//   - STATE_CONDITIONAL: legal status depends on jurisdiction (e.g. cannabis).
//   - ELEVATED: allowed but higher AML risk; a weight the model factors in.
//   - STANDARD: no special industry flag.

export type IndustryClass =
  | "PROHIBITED"
  | "STATE_CONDITIONAL"
  | "ELEVATED"
  | "STANDARD";

export interface IndustryFinding {
  classification: IndustryClass;
  category: string;
  riskWeight: number; // 0-10, contribution to overall risk
  rationale: string;
  guidance: string;
}

// Hard gates — banking generally prohibited or off-limits at federally regulated US institutions.
const PROHIBITED = [
  { match: ["weapon", "munition", "firearm", "ammunition", "explosive"], naics: ["3329", "4855", "45111"], category: "Weapons / munitions" },
  { match: ["unlicensed money", "unregistered msb", "money transmitter"], naics: ["5223"], category: "Unlicensed money services business" },
  { match: ["shell company", "unregistered investment", "unregistered fund"], naics: ["5511"], category: "Shell company / unregistered investment vehicle" },
];

// State-conditional — legal in some jurisdictions, federally illegal. Cannabis is the canonical case.
const STATE_CONDITIONAL = [
  {
    match: ["cannabis", "marijuana", "dispensary", "cbd", "hemp"],
    naics: ["111998", "453998"],
    category: "Cannabis / marijuana-related business",
  },
];

// Elevated AML risk — allowed, but enhanced due diligence expected.
const ELEVATED = [
  { match: ["crypto", "virtual currency", "digital asset", "bitcoin", "blockchain exchange"], category: "Virtual currency / digital assets", weight: 7 },
  { match: ["casino", "gambling", "gaming", "sportsbook", "betting"], category: "Gambling / gaming", weight: 6 },
  { match: ["precious metal", "jewel", "gold dealer", "bullion"], category: "Precious metals / jewels", weight: 6 },
  { match: ["car wash", "convenience store", "vending", "laundromat", "parking"], category: "Cash-intensive business", weight: 5 },
  { match: ["adult entertainment", "escort", "adult content"], category: "Adult entertainment", weight: 6 },
  { match: ["import", "export", "trade finance"], category: "Import/export (trade-based laundering risk)", weight: 5 },
];

// US states/territories where cannabis is broadly legal for adult/recreational or medical use
// (illustrative for the POC — the point is the conditional branch, not a perfect legal map).
const CANNABIS_PERMISSIVE_STATES = new Set([
  "CA", "CO", "WA", "OR", "NV", "AZ", "MA", "MI", "IL", "NJ", "NY",
  "CT", "VT", "ME", "MT", "NM", "RI", "VA", "MD", "MO", "AK", "MN", "OH", "DE",
]);

function hay(industry: string, naics?: string): string {
  return `${(industry || "").toLowerCase()} ${(naics || "").toLowerCase()}`;
}

export function assessIndustry(
  industry: string,
  naics?: string,
  state?: string
): IndustryFinding {
  const h = hay(industry, naics);

  // 1) Hard gates first
  for (const p of PROHIBITED) {
    const kw = p.match.some((m) => h.includes(m));
    const code = p.naics?.some((n) => (naics || "").startsWith(n));
    if (kw || code) {
      return {
        classification: "PROHIBITED",
        category: p.category,
        riskWeight: 10,
        rationale: `Industry "${industry}" falls under a prohibited category (${p.category}) for federally regulated US institutions.`,
        guidance: "Decline. This category is a hard gate regardless of other factors.",
      };
    }
  }

  // 2) State-conditional (cannabis)
  for (const s of STATE_CONDITIONAL) {
    const kw = s.match.some((m) => h.includes(m));
    const code = s.naics?.some((n) => (naics || "").startsWith(n));
    if (kw || code) {
      const st = (state || "").toUpperCase();
      const permissive = CANNABIS_PERMISSIVE_STATES.has(st);
      if (!st) {
        return {
          classification: "STATE_CONDITIONAL",
          category: s.category,
          riskWeight: 8,
          rationale: `Industry "${industry}" is cannabis-related. Legality depends on the state of operation, which was not provided.`,
          guidance: "Escalate. Confirm state of operation; cannabis is federally illegal and only bankable under specific state programs with enhanced due diligence.",
        };
      }
      if (permissive) {
        return {
          classification: "STATE_CONDITIONAL",
          category: s.category,
          riskWeight: 7,
          rationale: `Cannabis-related business in ${st}, a state with a legal cannabis program. Federally illegal but bankable under FinCEN's 2014 guidance with enhanced due diligence.`,
          guidance: "Escalate for enhanced due diligence (SAR-marijuana framework, state license verification). Do not auto-approve.",
        };
      }
      return {
        classification: "PROHIBITED",
        category: s.category,
        riskWeight: 10,
        rationale: `Cannabis-related business in ${st}, which does not have a broad legal cannabis program. Treated as a hard gate.`,
        guidance: "Decline in this jurisdiction.",
      };
    }
  }

  // 3) Elevated risk
  for (const e of ELEVATED) {
    if (e.match.some((m) => h.includes(m))) {
      return {
        classification: "ELEVATED",
        category: e.category,
        riskWeight: e.weight,
        rationale: `Industry "${industry}" is an elevated AML-risk category (${e.category}).`,
        guidance: "Permitted with enhanced due diligence. Weigh alongside sanctions, ownership, and country risk.",
      };
    }
  }

  // 4) Standard
  return {
    classification: "STANDARD",
    category: "Standard commercial",
    riskWeight: 1,
    rationale: `Industry "${industry}" carries no special AML industry flag.`,
    guidance: "No industry-specific escalation. Apply standard due diligence.",
  };
}
