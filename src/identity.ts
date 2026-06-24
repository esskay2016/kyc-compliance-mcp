// Identity verification — FREE structural validation, no external data, no key.
//
// IMPORTANT SCOPE: this validates whether identifiers are STRUCTURALLY VALID
// (a real-looking SSN format, a DL number matching the claimed state's pattern, an
// address present). It does NOT verify that the SSN/DL actually BELONGS to the person —
// that requires authoritative sources that are legally gated:
//   - SSA eCBSV (permitted entities + consumer consent) for SSN-to-name match
//   - AAMVA / state DMV (government-restricted) for DL-to-record match
//   - or a licensed provider (Plaid, Signzy, etc.)
// Those are documented integration points. Structural validation is a legitimate
// first-pass fraud filter that real onboarding runs BEFORE paying for the authoritative
// lookup — fabricated SSNs very often violate the SSA's own structural rules.

export type IdentityVerdict = "VALID_FORMAT" | "INVALID_FORMAT" | "SUSPICIOUS" | "INSUFFICIENT_DATA";

export interface IdentityFinding {
  verdict: IdentityVerdict;
  checks: {
    ssn?: { provided: boolean; valid: boolean; reason: string };
    driversLicense?: { provided: boolean; valid: boolean; reason: string };
    address?: { provided: boolean; reason: string };
  };
  authoritativeMatch: "INTEGRATION_POINT";
  note: string;
}

// ---- SSN structural validation per SSA rules ----
// Format: AAA-GG-SSSS. Invalid: area 000, 666, 900-999; group 00; serial 0000.
function validateSSN(ssnRaw: string): { valid: boolean; reason: string } {
  const digits = (ssnRaw || "").replace(/\D/g, "");
  if (digits.length !== 9) {
    return { valid: false, reason: "SSN must be 9 digits." };
  }
  const area = digits.slice(0, 3);
  const group = digits.slice(3, 5);
  const serial = digits.slice(5);

  const areaNum = parseInt(area, 10);
  if (area === "000") return { valid: false, reason: "Area number 000 is invalid." };
  if (area === "666") return { valid: false, reason: "Area number 666 is invalid." };
  if (areaNum >= 900) return { valid: false, reason: "Area numbers 900-999 are invalid (reserved/ITIN range)." };
  if (group === "00") return { valid: false, reason: "Group number 00 is invalid." };
  if (serial === "0000") return { valid: false, reason: "Serial number 0000 is invalid." };

  // Known fabricated/advertising SSNs (e.g. 078-05-1120, 219-09-9999)
  const knownBad = new Set(["078051120", "219099999", "123456789"]);
  if (knownBad.has(digits)) {
    return { valid: false, reason: "SSN matches a known invalid/placeholder number." };
  }
  return { valid: true, reason: "SSN is structurally valid (format and range pass SSA rules)." };
}

// ---- Driver's license format per state (illustrative subset) ----
// Real systems carry all 50 states' patterns; this covers common ones for the POC.
const DL_PATTERNS: Record<string, { re: RegExp; desc: string }> = {
  CA: { re: /^[A-Z]\d{7}$/, desc: "1 letter + 7 digits" },
  NY: { re: /^\d{9}$/, desc: "9 digits" },
  TX: { re: /^\d{8}$/, desc: "8 digits" },
  FL: { re: /^[A-Z]\d{12}$/, desc: "1 letter + 12 digits" },
  IL: { re: /^[A-Z]\d{11,12}$/, desc: "1 letter + 11-12 digits" },
  WA: { re: /^[A-Z0-9]{12}$/, desc: "12 alphanumeric" },
  NJ: { re: /^[A-Z]\d{14}$/, desc: "1 letter + 14 digits" },
  PA: { re: /^\d{8}$/, desc: "8 digits" },
  OH: { re: /^[A-Z]{2}\d{6}$/, desc: "2 letters + 6 digits" },
  GA: { re: /^\d{7,9}$/, desc: "7-9 digits" },
};

function validateDL(dlRaw: string, state: string): { valid: boolean; reason: string } {
  const dl = (dlRaw || "").toUpperCase().replace(/\s/g, "");
  const st = (state || "").toUpperCase();
  const pattern = DL_PATTERNS[st];
  if (!pattern) {
    return { valid: true, reason: `No format rule on file for state ${st || "(none)"}; structural check skipped.` };
  }
  if (pattern.re.test(dl)) {
    return { valid: true, reason: `DL matches ${st} format (${pattern.desc}).` };
  }
  return { valid: false, reason: `DL does not match expected ${st} format (${pattern.desc}).` };
}

export function verifyIdentity(input: {
  ssn?: string;
  driversLicense?: string;
  state?: string;
  address?: string;
}): IdentityFinding {
  const checks: IdentityFinding["checks"] = {};
  let anyProvided = false;
  let anyInvalid = false;

  if (input.ssn) {
    anyProvided = true;
    const r = validateSSN(input.ssn);
    checks.ssn = { provided: true, valid: r.valid, reason: r.reason };
    if (!r.valid) anyInvalid = true;
  } else {
    checks.ssn = { provided: false, valid: false, reason: "No SSN provided." };
  }

  if (input.driversLicense) {
    anyProvided = true;
    const r = validateDL(input.driversLicense, input.state || "");
    checks.driversLicense = { provided: true, valid: r.valid, reason: r.reason };
    if (!r.valid) anyInvalid = true;
  } else {
    checks.driversLicense = { provided: false, valid: false, reason: "No driver's license provided." };
  }

  const hasAddress = !!(input.address && input.address.trim().length >= 5);
  checks.address = {
    provided: hasAddress,
    reason: hasAddress ? "Address present." : "No usable address provided.",
  };
  if (hasAddress) anyProvided = true;

  let verdict: IdentityVerdict;
  if (!anyProvided) verdict = "INSUFFICIENT_DATA";
  else if (anyInvalid) verdict = "INVALID_FORMAT";
  else verdict = "VALID_FORMAT";

  return {
    verdict,
    checks,
    authoritativeMatch: "INTEGRATION_POINT",
    note:
      "Structural validation only. Authoritative identity match (SSN-to-name via SSA eCBSV, " +
      "DL-to-record via AAMVA/DMV, both legally gated) is a production integration point. " +
      (verdict === "INVALID_FORMAT"
        ? "One or more identifiers failed structural validation — treat as a red flag."
        : verdict === "VALID_FORMAT"
        ? "Identifiers are structurally valid; authoritative match still required before final clearance."
        : "Insufficient identity data provided to validate."),
  };
}
