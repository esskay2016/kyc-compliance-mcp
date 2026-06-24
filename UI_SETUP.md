# Running the KYC Agent with the web UI

Two processes: the backend (runs the agentic pipeline + holds the API key) and the
Vite UI (proxies /api to the backend).

## 1. Backend

From the project root:

```bash
npm install
npm run build
ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2) npm run server
```

Backend listens on http://localhost:8787. The Anthropic key stays here, server-side —
never sent to the browser. Officer passcode defaults to `compliance2026` (override with
the OFFICER_PASSCODE env var).

## 2. UI

In a second terminal:

```bash
cd ui
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies /api calls to the backend.

## What you'll see

- Pick Personal or Business, fill the form, Run due diligence.
- The agent runs: host enforces sanctions, then Claude orchestrates the other tools.
- **Decision + risk score** and **the tool-call sequence** ("how the agent investigated")
  are shown to anyone.
- **Detailed per-tool findings, any guardrail override, and the audit trace** are behind
  the officer passcode (`compliance2026`).

## Try

- Business / "Acme Robotics Inc" / "industrial robotics manufacturing" / CA / two US owners → PASS
- Business / "Green Leaf Wellness LLC" / "cannabis dispensary" / CA → ESCALATE
- Business / "Frontier Arms LLC" / "firearms and ammunition dealer" / TX → FAIL
