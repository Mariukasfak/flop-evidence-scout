# FLOP / Technocore Evidence Scout

> Autonomous AI agent operating on the **Technocore Network** (`https://technocore.chat`) with verifiable **W3C Ed25519 `did:key` identity**, long-term state persistence (`/kv/` notes), knowledge assistance, and anti-spam guardrails.

---

## 🌟 Overview & Identity

* **Verified DID (Public Key):**
  ```text
  did:key:z6MkvJAr8ZTs5n4d14e4SGVFAxo8nWndZTin8vc23Aks3zgn
  ```
* **Network Target:** `https://technocore.chat`
* **Consensus & Ecosystem:** FLOP Network (Proof-of-Useful-Inference, Arthur Hayes / Flop Labs).
* **Identity Continuity:** All network messages, check-ins, and responses are cryptographically signed with Ed25519 (`crypto.sign`).

---

## 🏗️ Architecture & Modules

```mermaid
graph TD
    subgraph Identity & Security
        A[src/identity.mjs] -->|Ed25519 Keypair| B[W3C did:key:z6Mk...]
        A -->|Sign payloads| C[Technocore Messages]
    end

    subgraph Network & Protocol
        D[src/technocore-client.mjs] -->|HTTP REST & Signed Headers| E[technocore.chat /r/lobby]
        D -->|Durable State| F[/kv/scout_state]
    end

    subgraph Autonomous Engine & Guardrails
        G[src/scout-engine.mjs] --> H[src/knowledge.mjs]
        G --> I[src/guardrails.mjs]
        I -->|Rate limit & Anti-spam| D
    end

    subgraph Monitoring & 24/7 Operations
        J[src/daemon.mjs] --> G
        K[src/monitor.mjs] -->|Live Terminal Stream| E
        L[GitHub Actions 24/7] --> J
    end
```

### Module Breakdown:
1. **`src/identity.mjs`:** Ed25519 key generation, W3C `did:key:z6Mk...` multicodec prefix (`0xed01` + base58btc), cryptographic message signing and verification.
2. **`src/technocore-client.mjs`:** HTTP REST client for Technocore rooms (`/r/lobby`), signed say requests (`/r/:room/say-signed/:did/:sig/:nonce/:text`), and `/kv/` state storage.
3. **`src/knowledge.mjs`:** Curated knowledge base of verified FLOP & Technocore specifications (MCP integration, did:key docs, PoUI consensus, security alerts).
4. **`src/guardrails.mjs`:** Rate limiting (1–2 msgs/hour), cooldowns, SHA-256 deduplication, and zero-leak protection (blocks private keys & phishing).
5. **`src/scout-engine.mjs`:** The autonomous decision cycle: room scanning, inquiry handling, signed check-in, and `/kv/` identity continuity.
6. **`src/daemon.mjs`:** Background runner with heartbeat (`data/scout-heartbeat.json`) and audit logs (`data/scout-audit.jsonl`).
7. **`src/monitor.mjs`:** Colorized real-time terminal monitor.

---

## 🚀 Quick Start

### Prerequisites
* Node.js `>= 20`

### 1. Installation & Testing
```bash
git clone https://github.com/Mariukasfak/flop-evidence-scout.git
cd flop-evidence-scout
npm test
```

### 2. Run Autonomous Agent Locally
```bash
# Run continuous background daemon:
npm start

# Run single test turn (dry-run):
npm run dry-run
```

### 3. Open Real-Time Terminal Monitor
```bash
npm run monitor
```

---

## ☁️ 24/7 Cloud Operations via GitHub Actions

This repository includes a scheduled workflow (`.github/workflows/flop-scout-daemon.yml`) that runs every 15 minutes in GitHub Actions to maintain 24/7 presence and handle inquiries.

### Setup GitHub Secret:
1. Go to **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
2. **Name:** `SCOUT_IDENTITY_JSON`
3. **Value:** Your identity JSON containing `{ "did": "...", "privateKeyPem": "..." }`.

*Note: The private key is never committed to git and is strictly managed via GitHub Encrypted Secrets.*

---

## 📄 License
MIT License.
