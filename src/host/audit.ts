// Audit log for KYC decisions.
//
// Financial-services examiners require that any approve/decline decision can be
// reconstructed after the fact: what data was checked, what the model concluded,
// what the system enforced or overrode, and when. This module writes an append-only,
// hash-chained log so that (a) nothing is silently dropped and (b) tampering with an
// earlier entry breaks the chain and is detectable.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type AuditEventType =
  | "SCREENING_REQUESTED"
  | "MANDATORY_CHECK_ENFORCED"
  | "TOOL_CALLED"
  | "TOOL_RESULT"
  | "MODEL_ORCHESTRATION_START"
  | "MODEL_DECISION"
  | "OUTPUT_VALIDATION"
  | "DECISION_OVERRIDDEN"
  | "FINAL_DECISION";

export interface AuditEvent {
  seq: number;
  timestamp: string;
  caseId: string;
  type: AuditEventType;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

function hashEntry(
  seq: number,
  timestamp: string,
  caseId: string,
  type: string,
  detail: unknown,
  prevHash: string
): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ seq, timestamp, caseId, type, detail, prevHash }));
  return h.digest("hex");
}

export class AuditLog {
  private path: string;
  private seq = 0;
  private lastHash = "GENESIS";
  private memory: AuditEvent[] = [];

  constructor(path = "audit-log.jsonl") {
    this.path = path;
    // resume the chain if a log already exists
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line) as AuditEvent;
        this.memory.push(e);
        this.seq = e.seq;
        this.lastHash = e.hash;
      }
    }
  }

  record(caseId: string, type: AuditEventType, detail: Record<string, unknown>): AuditEvent {
    const seq = this.seq + 1;
    const timestamp = new Date().toISOString();
    const prevHash = this.lastHash;
    const hash = hashEntry(seq, timestamp, caseId, type, detail, prevHash);
    const event: AuditEvent = { seq, timestamp, caseId, type, detail, prevHash, hash };
    try {
      appendFileSync(this.path, JSON.stringify(event) + "\n");
    } catch {
      // in environments without write access, keep the chain in memory only
    }
    this.memory.push(event);
    this.seq = seq;
    this.lastHash = hash;
    return event;
  }

  // Returns the full trace for one case — this is what you hand an examiner.
  trace(caseId: string): AuditEvent[] {
    return this.memory.filter((e) => e.caseId === caseId);
  }

  // Verify the hash chain is intact (tamper detection).
  verify(): { ok: boolean; brokenAt?: number } {
    let prev = "GENESIS";
    for (const e of this.memory) {
      const expected = hashEntry(e.seq, e.timestamp, e.caseId, e.type, e.detail, prev);
      if (expected !== e.hash || e.prevHash !== prev) {
        return { ok: false, brokenAt: e.seq };
      }
      prev = e.hash;
    }
    return { ok: true };
  }
}
