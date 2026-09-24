#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyEvidenceLine } from "./verify-evidence.mjs";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}

function loadEntries(dir) {
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => /^signed-posts-.*\.jsonl$/.test(name)).sort()
    : [];
  const entries = [];
  for (const file of files) {
    for (const raw of fs.readFileSync(path.join(dir, file), "utf8").split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const entry = JSON.parse(raw);
      entries.push({ ...entry, verified: verifyEvidenceLine(entry) });
    }
  }
  return { files, entries };
}

const dir = path.resolve(process.argv[2] || "data/local/evidence");
const out = path.resolve(process.argv[3] || "evidence/flop-evidence-envelope.json");
const { files, entries } = loadEntries(dir);
if (entries.length === 0) throw new Error("NO_SIGNED_EVIDENCE");
const failed = entries.filter((entry) => !entry.verified);
const latest = entries.map((entry) => entry.at).filter(Boolean).sort().at(-1) || new Date(0).toISOString();
const core = {
  schema: "flop.evidence-envelope.v1",
  subject: {
    kind: "technocore-signed-post-archive",
    id: "Mariukasfak/flop-evidence-scout",
  },
  source: {
    uri: "data/local/evidence/signed-posts-*.jsonl",
    sourceClass: "COMMUNITY",
    revision: process.env.GITHUB_SHA || "local",
    observedAt: latest,
  },
  payload: {
    type: "technocore-signed-post-archive",
    value: {
      files,
      total: entries.length,
      verified: entries.length - failed.length,
      failed: failed.length,
      entries: entries.map(({ verified, ...entry }) => entry),
    },
  },
  verification: {
    state: failed.length === 0 ? "VERIFIED" : "INVALID",
    verifier: "flop-evidence-scout/tools/verify-evidence.mjs",
    checks: [{ id: "all-ed25519-signatures", ok: failed.length === 0, detail: `${failed.length} failed` }],
  },
  claims: [{ type: "signed-post-archive-integrity", value: failed.length === 0, normative: false }],
  limitations: [
    "Signatures prove key control for room|nonce|text, not identity, usefulness, payment, or global history.",
    "Server-assigned seq and ts are observational metadata and are not covered by the DID signature.",
  ],
  provenance: files.map((file) => ({ source: file })),
};
const canonical = canonicalize(core);
const envelope = {
  ...core,
  canonical,
  sha256: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ implementation: "Mariukasfak/flop-evidence-scout", revision: process.env.GITHUB_SHA || "local", envelope }, null, 2) + "\n");
console.log(out);
