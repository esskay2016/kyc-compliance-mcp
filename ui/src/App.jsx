import { useState } from "react";

const USE_CASES = [
  { key: "personal", label: "Personal", sub: "Individual applicant" },
  { key: "business", label: "Business", sub: "Entity + beneficial owners" },
];

const DECISION_STYLE = {
  PASS: { bg: "#e7f5ec", border: "#1f8b4c", text: "#0f5c30", dot: "#1f8b4c" },
  FAIL: { bg: "#fdeaea", border: "#c0392b", text: "#7d211a", dot: "#c0392b" },
  ESCALATE: { bg: "#fef6e7", border: "#d68910", text: "#8a5a08", dot: "#d68910" },
};

const TOOL_LABEL = {
  screen_sanctions: "OFAC sanctions screen",
  assess_industry_risk: "Industry risk classification",
  lookup_business: "SEC EDGAR business verification",
  screen_pep: "PEP screening",
  assess_country_risk: "Country risk assessment",
  verify_identity: "Identity document validation",
};

// distinct accent per applicant type so it's obvious which form you're filling
const TYPE_THEME = {
  personal: { accent: "#1f6fb2", soft: "#eef4fb", tag: "PERSONAL APPLICANT" },
  business: { accent: "#6b4ea8", soft: "#f1ecf9", tag: "BUSINESS APPLICANT" },
};

export default function App() {
  const [type, setType] = useState("business");
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // passcode-gated detail
  const [passcode, setPasscode] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const switchType = (t) => {
    setType(t);
    setForm({});
    setResult(null);
    setError(null);
    setDetail(null);
    setPasscode("");
    setDetailError(null);
  };

  const submit = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setDetail(null);
    setPasscode("");
    setDetailError(null);
    try {
      const resp = await fetch("/api/screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...form }),
      });
      const data = await resp.json();
      if (!resp.ok) setError(data.error || "Screening failed.");
      else setResult(data.visible);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const unlock = async () => {
    setDetailError(null);
    try {
      const resp = await fetch("/api/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: result.caseId, passcode }),
      });
      const data = await resp.json();
      if (!resp.ok) setDetailError(data.error || "Could not unlock.");
      else setDetail(data.gated);
    } catch (e) {
      setDetailError(String(e));
    }
  };

  return (
    <div style={S.page}>
      <div style={S.shell}>
        <header style={S.header}>
          <div style={S.mark}>◈</div>
          <div>
            <h1 style={S.h1}>KYC / AML Compliance Agent</h1>
            <p style={S.sub}>MCP-orchestrated due diligence · US framework · live OFAC / World Bank / SEC EDGAR</p>
          </div>
        </header>

        <div style={S.tabs}>
          {USE_CASES.map((uc) => (
            <button key={uc.key} onClick={() => switchType(uc.key)}
              style={{ ...S.tab, ...(uc.key === type ? { ...S.tabActive, borderBottomColor: TYPE_THEME[uc.key].accent } : {}) }}>
              <span style={S.tabLabel}>{uc.label}</span>
              <span style={S.tabSub}>{uc.sub}</span>
            </button>
          ))}
        </div>

        <div style={S.body}>
          <div style={{ ...S.formCol, background: TYPE_THEME[type].soft }}>
            <div style={{ ...S.typeTag, color: TYPE_THEME[type].accent, borderColor: TYPE_THEME[type].accent }}>
              {TYPE_THEME[type].tag}
            </div>
            <Form type={type} form={form} update={update} />
            <button style={{ ...S.submit, background: TYPE_THEME[type].accent }} onClick={submit} disabled={loading}>
              {loading ? "Agent running…" : "Run due diligence"}
            </button>
            {error && <div style={S.error}>{error}</div>}
          </div>

          <div style={S.resultCol}>
            {!result && !loading && (
              <div style={S.placeholder}>
                <div style={S.placeholderMark}>◇</div>
                <p>Submit an applicant. The agent will orchestrate the compliance tools and return a decision.</p>
              </div>
            )}
            {loading && <div style={S.placeholder}><p>Claude is orchestrating the screening tools…</p></div>}
            {result && (
              <Result
                result={result}
                passcode={passcode} setPasscode={setPasscode}
                unlock={unlock} detail={detail} detailError={detailError}
              />
            )}
          </div>
        </div>
      </div>
      <p style={S.footer}>Detailed findings &amp; audit trace are officer-gated. Demo passcode: compliance2026</p>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={S.field}><span style={S.label}>{label}</span>{children}</label>;
}

function Form({ type, form, update }) {
  const input = (k, props = {}) => (
    <input style={S.input} value={form[k] || ""} onChange={(e) => update(k, e.target.value)} {...props} />
  );

  if (type === "personal") {
    return (
      <>
        <Field label="Full name">{input("fullName", { placeholder: "Jane Doe" })}</Field>
        <div style={S.row}>
          <Field label="Date of birth">{input("dob", { type: "date" })}</Field>
          <Field label="Country">{input("country", { placeholder: "United States" })}</Field>
        </div>
        <Field label="Residential address">{input("address", { placeholder: "123 Main St, Springfield, IL" })}</Field>
        <div style={S.row}>
          <Field label="SSN">{input("ssn", { placeholder: "123-45-6789" })}</Field>
          <Field label="State">{input("state", { placeholder: "CA" })}</Field>
        </div>
        <Field label="Driver's license #">{input("driversLicense", { placeholder: "D1234567" })}</Field>
        <Field label="Purpose of account">{input("purpose", { placeholder: "Personal checking" })}</Field>
      </>
    );
  }
  return (
    <>
      <div style={S.row}>
        <Field label="Company name">{input("companyName", { placeholder: "Acme Robotics Inc" })}</Field>
        <Field label="EIN">{input("ein", { placeholder: "12-3456789" })}</Field>
      </div>
      <div style={S.row}>
        <Field label="Industry">{input("industry", { placeholder: "industrial robotics manufacturing" })}</Field>
        <Field label="State">{input("state", { placeholder: "CA" })}</Field>
      </div>
      <div style={S.ownerCard}>
        <div style={S.ownerTitle}>Beneficial owner 1</div>
        <div style={S.row}>
          <Field label="Full name">{input("owner1Name")}</Field>
          <Field label="Country">{input("owner1Country", { placeholder: "United States" })}</Field>
        </div>
      </div>
      <div style={S.ownerCard}>
        <div style={S.ownerTitle}>Beneficial owner 2</div>
        <div style={S.row}>
          <Field label="Full name">{input("owner2Name")}</Field>
          <Field label="Country">{input("owner2Country", { placeholder: "United States" })}</Field>
        </div>
      </div>
    </>
  );
}

function Result({ result, passcode, setPasscode, unlock, detail, detailError }) {
  const st = DECISION_STYLE[result.decision] || DECISION_STYLE.ESCALATE;
  return (
    <div>
      <div style={{ ...S.decision, background: st.bg, borderColor: st.border, color: st.text }}>
        <div style={{ ...S.decisionDot, background: st.dot }} />
        <div>
          <div style={S.decisionLabel}>{result.decision}</div>
          <div style={S.riskline}>Risk score {result.riskScore}/10{result.overridden ? " · guardrail override" : ""}</div>
        </div>
      </div>
      <p style={S.summary}>{result.summary}</p>

      {/* VISIBLE: tool-call sequence timeline */}
      <div style={S.timelineBox}>
        <div style={S.sectionTitle}>How the agent investigated</div>
        <div style={S.timeline}>
          {result.toolSequence.map((t, i) => (
            <div key={i} style={S.tlRow}>
              <div style={S.tlNum}>{t.step}</div>
              <div style={S.tlBody}>
                <div style={S.tlTool}>{TOOL_LABEL[t.tool] || t.tool}</div>
                <div style={S.tlBy}>{t.by === "host" ? "enforced by host (mandatory)" : "called by Claude"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* GATED: detailed findings + audit trace */}
      <div style={S.lockBox}>
        <div style={S.sectionTitle}>Detailed findings &amp; audit trace</div>
        {!detail ? (
          <>
            <p style={S.lockNote}>Officer-gated. Enter passcode to view per-tool findings, override reasoning, and the audit trail.</p>
            <div style={S.row}>
              <input style={S.input} type="password" placeholder="Officer passcode"
                value={passcode} onChange={(e) => setPasscode(e.target.value)} />
              <button style={S.unlock} onClick={unlock}>Unlock</button>
            </div>
            {detailError && <div style={S.error}>{detailError}</div>}
          </>
        ) : (
          <Detail detail={detail} decision={result.decision} />
        )}
      </div>
    </div>
  );
}

function Detail({ detail, decision }) {
  const f = detail.facts || {};
  return (
    <div>
      {detail.overrideReasons?.length > 0 && (
        <div style={S.override}>
          <strong>Guardrail override:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {detail.overrideReasons.map((r, i) => <li key={i} style={{ fontSize: 13 }}>{r}</li>)}
          </ul>
        </div>
      )}

      <div style={S.findingGroup}>
        <div style={S.fgTitle}>Sanctions (OFAC SDN)</div>
        {(f.sanctions || []).map((s, i) => (
          <div key={i} style={S.fRow}>
            <span>{s.name}</span>
            <span style={{ color: s.potentialMatch ? "#c0392b" : "#1f8b4c", fontWeight: 600 }}>
              {s.potentialMatch ? "POTENTIAL MATCH" : "clear"}
            </span>
          </div>
        ))}
      </div>

      {f.identity && (
        <div style={S.findingGroup}>
          <div style={S.fgTitle}>Identity validation (structural)</div>
          <div style={S.fRow}>
            <span>Document format check</span>
            <span style={{ fontWeight: 600, color: f.identity.verdict === "VALID_FORMAT" ? "#1f8b4c" : f.identity.verdict === "INVALID_FORMAT" ? "#c0392b" : "#8a5a08" }}>
              {f.identity.verdict}
            </span>
          </div>
        </div>
      )}

      {f.industry && (
        <div style={S.findingGroup}>
          <div style={S.fgTitle}>Industry</div>
          <div style={S.fRow}><span>{f.industry.category}</span><span style={{ fontWeight: 600 }}>{f.industry.classification}</span></div>
        </div>
      )}

      {f.countryRisk && (
        <div style={S.findingGroup}>
          <div style={S.fgTitle}>Country risk</div>
          {f.countryRisk.map((c, i) => (
            <div key={i} style={S.fRow}><span>Party {i + 1}</span><span style={{ fontWeight: 600 }}>{c.riskScore}/10 · {c.band}</span></div>
          ))}
        </div>
      )}

      <div style={S.findingGroup}>
        <div style={S.fgTitle}>Audit trace {detail.auditIntact ? "· chain intact ✓" : "· CHAIN BROKEN"}</div>
        <div style={S.auditList}>
          {detail.auditTrace.map((e) => (
            <div key={e.seq} style={S.auditRow}><span style={S.auditSeq}>{e.seq}</span><span>{e.type}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", background: "#0d1b2a", padding: "32px 16px", fontFamily: "'Inter', sans-serif", color: "#1a2332" },
  shell: { maxWidth: 1060, margin: "0 auto", background: "#fff", borderRadius: 16, overflow: "hidden", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" },
  header: { display: "flex", alignItems: "center", gap: 16, padding: "26px 32px", background: "#0d1b2a", color: "#fff" },
  mark: { fontSize: 30, color: "#5a9bd4" },
  h1: { margin: 0, fontSize: 21, fontWeight: 700 },
  sub: { margin: "4px 0 0", fontSize: 12.5, color: "#9bb3c9" },
  tabs: { display: "flex", borderBottom: "1px solid #e3e8ee" },
  tab: { flex: 1, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "13px 18px", border: "none", borderBottom: "3px solid transparent", background: "#f6f8fa", cursor: "pointer", textAlign: "left" },
  tabActive: { background: "#fff", borderBottomColor: "#1f6fb2" },
  tabLabel: { fontSize: 14, fontWeight: 600 },
  tabSub: { fontSize: 11, color: "#7a8aa0", textTransform: "uppercase", letterSpacing: 0.5 },
  body: { display: "flex" },
  formCol: { flex: "1 1 0", padding: 26, borderRight: "1px solid #e3e8ee", minWidth: 0 },
  typeTag: { display: "inline-block", fontSize: 11, fontWeight: 700, letterSpacing: 0.8, padding: "4px 10px", border: "1px solid", borderRadius: 20, marginBottom: 16 },
  resultCol: { flex: "1 1 0", padding: 26, minWidth: 0 },
  row: { display: "flex", gap: 12 },
  field: { display: "flex", flexDirection: "column", gap: 5, marginBottom: 13, flex: 1, minWidth: 0 },
  label: { fontSize: 12, fontWeight: 600, color: "#5a6a80" },
  input: { padding: "9px 11px", border: "1px solid #cdd6e0", borderRadius: 8, fontSize: 14, outline: "none", width: "100%", boxSizing: "border-box" },
  ownerCard: { padding: 13, background: "#f6f8fa", borderRadius: 10, marginBottom: 13 },
  ownerTitle: { fontSize: 12, fontWeight: 700, color: "#1f6fb2", marginBottom: 9 },
  submit: { marginTop: 6, width: "100%", padding: 12, background: "#1f6fb2", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer" },
  error: { marginTop: 10, color: "#c0392b", fontSize: 13 },
  placeholder: { minHeight: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#9bb3c9", textAlign: "center", gap: 8 },
  placeholderMark: { fontSize: 38, color: "#cdd6e0" },
  decision: { display: "flex", alignItems: "center", gap: 14, padding: "15px 18px", borderRadius: 12, border: "2px solid" },
  decisionDot: { width: 14, height: 14, borderRadius: "50%" },
  decisionLabel: { fontSize: 20, fontWeight: 800, letterSpacing: 0.5 },
  riskline: { fontSize: 13, opacity: 0.85 },
  summary: { fontSize: 14, lineHeight: 1.55, color: "#34435a", margin: "14px 2px" },
  sectionTitle: { fontSize: 13, fontWeight: 700, color: "#1a2332", marginBottom: 10 },
  timelineBox: { marginTop: 8, padding: 16, background: "#f6f8fa", borderRadius: 12 },
  timeline: { display: "flex", flexDirection: "column", gap: 8 },
  tlRow: { display: "flex", gap: 11, alignItems: "center" },
  tlNum: { width: 22, height: 22, borderRadius: "50%", background: "#1f6fb2", color: "#fff", fontSize: 12, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  tlBody: { minWidth: 0 },
  tlTool: { fontSize: 13.5, fontWeight: 600, color: "#1a2332" },
  tlBy: { fontSize: 11.5, color: "#7a8aa0" },
  lockBox: { marginTop: 14, padding: 16, background: "#f6f8fa", borderRadius: 12 },
  lockNote: { fontSize: 13, color: "#7a8aa0", margin: "0 0 12px", lineHeight: 1.5 },
  unlock: { padding: "9px 18px", background: "#1a2332", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" },
  override: { padding: 12, background: "#fef6e7", border: "1px solid #d68910", borderRadius: 8, marginBottom: 12, fontSize: 13, color: "#8a5a08" },
  findingGroup: { marginBottom: 14 },
  fgTitle: { fontSize: 11, fontWeight: 700, color: "#1f6fb2", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 },
  fRow: { display: "flex", justifyContent: "space-between", fontSize: 13.5, padding: "5px 0", borderBottom: "1px solid #e3e8ee", color: "#34435a" },
  auditList: { display: "flex", flexDirection: "column", gap: 2 },
  auditRow: { display: "flex", gap: 10, fontSize: 12.5, color: "#5a6a80", padding: "2px 0" },
  auditSeq: { width: 20, color: "#9bb3c9", textAlign: "right" },
  footer: { textAlign: "center", color: "#5a7088", fontSize: 12, marginTop: 18 },
};
