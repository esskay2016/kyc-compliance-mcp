// Public data-source clients. Each MCP tool wraps one of these.
// All sources are public and free; no API keys required for the POC.

// ---------- OFAC SDN sanctions screening ----------
// Pulls the public SDN list and does token-based name matching.
// NOTE: intentionally simple. Production screening uses fuzzy/phonetic matching
// plus secondary identifiers (DOB, nationality). This demonstrates the data path.

let sdnCache: { text: string; fetchedAt: number } | null = null;
const SDN_TTL_MS = 1000 * 60 * 60; // 1 hour

async function getSDN(): Promise<string> {
  const now = Date.now();
  if (sdnCache && now - sdnCache.fetchedAt < SDN_TTL_MS) {
    return sdnCache.text;
  }
  const resp = await fetch("https://www.treasury.gov/ofac/downloads/sdn.csv");
  if (!resp.ok) throw new Error(`OFAC SDN fetch failed: ${resp.status}`);
  const text = await resp.text();
  sdnCache = { text, fetchedAt: now };
  return text;
}

export interface SanctionsMatch {
  name: string;
  potentialMatch: boolean;
  matchedTokens: string[];
  note: string;
}

export async function screenSanctions(
  names: string[],
  extraLists: string[] = []
): Promise<{ source: string; results: SanctionsMatch[] }> {
  const sdnRaw = await getSDN();
  const sdn = sdnRaw.toLowerCase();

  // Normalize a name to "first ... last" word sequence for contiguous matching.
  const norm = (s: string) =>
    s.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

  const results: SanctionsMatch[] = [];
  const seen = new Set<string>(); // dedupe repeated names within one call
  for (const raw of names) {
    const name = (raw || "").trim();
    if (!name) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const tokens = key.split(" ").filter((t) => t.length >= 2);

    // Strong signal: the full normalized name appears as a contiguous substring
    // in the SDN data. This is what cuts the false positives — "jane miller" must
    // actually appear together, not "jane" somewhere and "miller" somewhere else.
    const fullContiguous = key.length >= 5 && sdn.includes(key);

    // Secondary signal for "Last, First" SDN formatting: try "last first" too.
    let reorderedContiguous = false;
    if (!fullContiguous && tokens.length >= 2) {
      const reordered = `${tokens[tokens.length - 1]} ${tokens.slice(0, -1).join(" ")}`;
      reorderedContiguous = sdn.includes(reordered);
    }

    const potentialMatch = fullContiguous || reorderedContiguous;
    results.push({
      name,
      potentialMatch,
      matchedTokens: potentialMatch ? tokens : [],
      note: potentialMatch
        ? "Full name appears in the OFAC SDN list — potential match requiring human review."
        : "No full-name match in OFAC SDN list.",
    });
  }
  const source =
    extraLists.length > 0
      ? `OFAC SDN (+requested: ${extraLists.join(", ")} — not yet wired, flagged for manual check)`
      : "OFAC SDN";
  return { source, results };
}

// ---------- World Bank country risk proxy ----------
// Uses World Bank governance/indicator data as a public risk proxy.
// We map a few indicators to a 0-10 risk score. Public, no key.

const COUNTRY_RISK_OVERRIDES: Record<string, number> = {
  // illustrative high-risk proxies for the POC
  "IR": 10, "KP": 10, "SY": 10, "CU": 9, "RU": 8, "VE": 8,
  "AF": 9, "MM": 8, "BY": 7,
  // low risk
  "US": 1, "CA": 1, "GB": 1, "DE": 1, "FR": 1, "JP": 1, "AU": 1,
};

const ISO2: Record<string, string> = {
  "united states": "US", "usa": "US", "canada": "CA", "united kingdom": "GB",
  "germany": "DE", "france": "FR", "japan": "JP", "australia": "AU",
  "iran": "IR", "north korea": "KP", "syria": "SY", "cuba": "CU",
  "russia": "RU", "venezuela": "VE", "afghanistan": "AF", "myanmar": "MM",
  "belarus": "BY",
};

export interface CountryRisk {
  country: string;
  iso2: string | null;
  riskScore: number; // 0-10
  band: "LOW" | "MEDIUM" | "HIGH";
  rationale: string;
}

export async function assessCountryRisk(country: string): Promise<CountryRisk> {
  const raw = (country || "").trim();
  const iso2 =
    raw.length === 2 ? raw.toUpperCase() : ISO2[raw.toLowerCase()] || null;

  let score: number | null = iso2 ? COUNTRY_RISK_OVERRIDES[iso2] ?? null : null;

  // Try World Bank "political stability" indicator as a live signal if not overridden.
  if (score === null && iso2) {
    try {
      const url = `https://api.worldbank.org/v2/country/${iso2}/indicator/PV.EST?format=json&mrnev=1`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        const val = data?.[1]?.[0]?.value;
        if (typeof val === "number") {
          // PV.EST ranges ~ -2.5 (worst) to +2.5 (best). Map to 0-10 risk.
          score = Math.max(0, Math.min(10, Math.round((2.5 - val) * 2)));
        }
      }
    } catch {
      // fall through to default
    }
  }

  if (score === null) score = 5; // unknown => medium

  const band = score >= 7 ? "HIGH" : score >= 4 ? "MEDIUM" : "LOW";
  return {
    country: raw,
    iso2,
    riskScore: score,
    band,
    rationale: iso2
      ? `Country risk for ${iso2} assessed at ${score}/10 (${band}).`
      : `Country "${raw}" could not be resolved to an ISO code; defaulted to medium risk.`,
  };
}

// ---------- SEC EDGAR business lookup ----------
// Uses the SEC's free, no-key company_tickers.json (every SEC-registered filer:
// name, ticker, CIK). EDGAR requires a descriptive User-Agent header or it blocks
// the request. NOTE: covers public / SEC-registered companies only — a no-match
// does NOT mean the company is fake, just that it isn't an SEC filer (most small
// private LLCs won't be). That nuance is surfaced in the note.

export interface BusinessMatch {
  found: boolean;
  query: string;
  candidates: Array<{ name: string; ticker: string; cik: string; source: string }>;
  note: string;
}

// SEC asks for a real contact in the User-Agent. Adjust to your own contact in production.
const SEC_UA = "KYC-Compliance-POC contact@example.com";

let tickerCache: { rows: any[]; fetchedAt: number } | null = null;
const TICKER_TTL_MS = 1000 * 60 * 60 * 24; // 24h — this file changes slowly

async function getCompanyTickers(): Promise<any[]> {
  const now = Date.now();
  if (tickerCache && now - tickerCache.fetchedAt < TICKER_TTL_MS) {
    return tickerCache.rows;
  }
  const resp = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`SEC company_tickers fetch failed: ${resp.status}`);
  const data = await resp.json();
  // data is an object keyed by index: { "0": {cik_str, ticker, title}, ... }
  const rows = Object.values(data);
  tickerCache = { rows, fetchedAt: now };
  return rows;
}

export async function lookupBusiness(
  companyName: string,
  _jurisdiction?: string
): Promise<BusinessMatch> {
  const query = (companyName || "").trim();
  const needle = query.toLowerCase();
  try {
    const rows = await getCompanyTickers();
    // match on company title containing the query tokens
    const scored = rows
      .map((r: any) => {
        const title = String(r.title || "").toLowerCase();
        let score = 0;
        if (title === needle) score = 3;
        else if (title.startsWith(needle)) score = 2;
        else if (title.includes(needle)) score = 1;
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const candidates = scored.map(({ r }) => ({
      name: r.title,
      ticker: r.ticker,
      cik: String(r.cik_str).padStart(10, "0"),
      source: "SEC EDGAR",
    }));

    return {
      found: candidates.length > 0,
      query,
      candidates,
      note: candidates.length
        ? "SEC-registered entity match found; verify exact entity and active filing status."
        : "No SEC EDGAR match. Entity is not an SEC filer — expected for most small/private LLCs. Verify via state registry (manual).",
    };
  } catch (e) {
    return {
      found: false,
      query,
      candidates: [],
      note: `SEC EDGAR lookup error: ${String(e)}. Flag for manual verification.`,
    };
  }
}

// ---------- PEP screening (integration-point stub) ----------
// Politically Exposed Person screening is a required KYC control, but credible PEP data
// is gated: OpenSanctions (free for non-commercial use, but API requires a key / commercial
// license) or vendors like World-Check / Dow Jones / LexisNexis. None offer a genuinely
// free, keyless public API the way OFAC, World Bank, and SEC EDGAR do. Rather than ship
// fake PEP results or silently omit the control, this is an explicit, honest integration
// point: the seam is built; production supplies credentials for a licensed provider.

export interface PEPResult {
  screened: boolean;
  query: string[];
  status: "INTEGRATION_POINT";
  note: string;
  recommendedProviders: string[];
}

export async function screenPEP(names: string[]): Promise<PEPResult> {
  return {
    screened: false,
    query: names,
    status: "INTEGRATION_POINT",
    note:
      "PEP screening is a required KYC control but is not wired to live data in this POC. " +
      "Credible PEP data is licensed (OpenSanctions requires an API key/commercial license; " +
      "World-Check, Dow Jones, LexisNexis are commercial). Integration point defined — " +
      "production supplies provider credentials. Treat as a manual EDD step until then.",
    recommendedProviders: ["OpenSanctions (key/license)", "Refinitiv World-Check", "Dow Jones RiskCenter", "LexisNexis"],
  };
}
