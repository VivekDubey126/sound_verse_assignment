# Soundverse AI — Enterprise Developer Platform

A self-serve developer API platform for AI music generation. Built to enforce multi-dimensional contracts: credit allowances, parallel generation limits, rate limits, license levels, idempotency, signed webhooks with SSRF prevention, and full security audit logging under concurrent load.

---

## ⚡ Quick Start (One Command)

```bash
# 1. Install dependencies
npm install

# 2. Start the API server & background workers
npm start
```

The platform runs at:
- **Developer Dashboard:** [http://localhost:3000](http://localhost:3000) (or [http://127.0.0.1:3000](http://127.0.0.1:3000))
- **Health Check:** [http://localhost:3000/health](http://localhost:3000/health)
- **OpenAPI 3.0 Spec:** [openapi.yaml](openapi.yaml)
- **Quickstart Guide:** [QUICKSTART.md](QUICKSTART.md)

---

## 🧪 Running Acceptance & Concurrency Tests

The automated test runner exercises all **14 Acceptance Scenarios** plus the **3 Should-Have features** (30 test assertions covering concurrency, race conditions, idempotency, SSRF, and failover):

```bash
npm test
```

### Direct test execution:
```bash
node tests/run-all.js
```

---

## 📋 Honest Status Table

| Feature Category | Requirement | Status | Notes & Verification |
|---|---|---|---|
| **Must: Accounts** | Signup, verify email (logged to console), login, dashboard | ✅ Complete | Verified in UI & test suite; JWT sessions + bcrypt |
| **Must: API Keys** | Secret shown once, list prefix/scopes/last_used, revoke, rotate, test vs live modes | ✅ Complete | SHA-256 hashed in DB; instant 401 on revocation; modal popup with 1-click copy |
| **Must: Async Generation** | Create job (202), poll status, list, cancel, expiring audio URL | ✅ Complete | State machine `queued` ➔ `running` ➔ `succeeded`; HMAC-signed URLs with expiry |
| **Must: Limits & Metering** | Parallel limits, hourly/daily rate limits, append-only ledger, hard stop | ✅ Complete | Serialized via `AccountLock`; verified under 20 instant requests |
| **Must: Idempotency** | `Idempotency-Key` header prevents duplicate creation/billing | ✅ Complete | In-flight 409, retry 202 cached, altered body 422 |
| **Must: Webhooks** | Register endpoint, HMAC-SHA256 signed events, backoff retries, SSRF shield | ✅ Complete | Tested against replay attacks & cloud metadata IPs (`169.254.169.254`) |
| **Must: Documentation** | OpenAPI 3.0 spec + 5-minute quickstart guide | ✅ Complete | Documented in `openapi.yaml` and `QUICKSTART.md` |
| **Must: Concurrency Tests** | Scenarios 1 to 14 executed under concurrency | ✅ Complete | 30/30 assertions pass in `tests/run-all.js` |
| **Should: Usage View** | Credits used and remaining, per key and per day breakdowns | ✅ Complete | Live interactive tabs in developer dashboard |
| **Should: Security Audit Log** | Who created, rotated, or revoked which key, and when | ✅ Complete | Displayed in dashboard table; stored in `audit_log` |
| **Should: Provider Failover** | Automatic fallback when primary music model is down or slow | ✅ Complete | Primary timeout seamlessly triggers backup provider |
| **Should: Team Members** | Team management with at least two roles | ✅ Complete | Supports `owner`, `developer`, and `viewer` roles |
| **Could: TypeScript/Python SDK** | Client wrapper libraries | ✂️ Scope Cut | Omitted; REST OpenAPI 3.0 is the universal contract |
| **Could: Stripe Overage** | Test mode Stripe overage billing | ✂️ Scope Cut | Omitted; hard stop and plan allowance enforced |
| **Could: Admin View** | Separate admin view to update plans | ✂️ Scope Cut | Handled dynamically via self-serve dashboard / API endpoint |
| **Could: MCP Server** | Exposing API as an MCP server | ✂️ Scope Cut | Omitted in favor of core HTTP concurrency & security |

---

## 🏛️ Architecture & System Design

```
                                ┌────────────────────────────────┐
                                │       Client / Developer       │
                                └────────────────┬───────────────┘
                                                 │ Authorization: Bearer sk_...
                                                 │ Idempotency-Key: ...
                                                 ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Express API Server (:3000)                                                                         │
│                                                                                                   │
│  [RequestId] ──► [API Key Auth (SHA-256)] ──► [Rate Limiter] ──► [Idempotency] ──► [Account Lock] │
└───────────────┬─────────────────────────────────────────────────────────────┬─────────────────────┘
                │                                                             │
                ▼                                                             ▼
┌─────────────────────────────────┐                         ┌──────────────────────────────────────┐
│ SQLite (WAL) / Node.js Engine   │                         │ Background Worker Loop               │
│ ─────────────────────────────── │                         │ ──────────────────────               │
│ • accounts & team_members       │                         │ • Polls queued generations (400ms)   │
│ • api_keys (hash + prefix)      │◄────────────────────────┤ • Invokes Provider (with Failover)   │
│ • generations (state machine)   │                         │ • Generates & stores audio MP3       │
│ • usage_ledger (append-only)    │                         │ • Signs expiring audio URL           │
│ • idempotency_keys (24h TTL)    │                         │ • Dispatches signed webhooks         │
│ • webhook_endpoints & logs      │                         └──────────────────┬───────────────────┘
│ • audit_log (security events)   │                                            │
└─────────────────────────────────┘                                            ▼
                                                            ┌──────────────────────────────────────┐
                                                            │ Webhook Destination (SSRF protected) │
                                                            └──────────────────────────────────────┘
```

---

## 💰 Plans & Limits Enforced

| Dimension | Sandbox | Starter | Growth |
|---|---|---|---|
| **Monthly Allowance** | 0 credits (test keys only) | 200 credits | 2,000 credits |
| **Parallel Generations** | 1 job | 3 jobs | 10 jobs |
| **Hourly Rate Limit** | 60 req/hr | 300 req/hr | 2,000 req/hr |
| **Daily Rate Limit** | 500 req/day | 3,000 req/day | 30,000 req/day |
| **Allowed Licenses** | `royalty_free` | `royalty_free`, `sync` | `royalty_free`, `sync`, `full_ownership` |
| **Beyond Allowance** | N/A | **Hard stop** (`429 allowance_exceeded`) | Allowed (overage) |

### Credit Cost by License:
- **`royalty_free`**: 1 credit per 60s
- **`sync`**: 6 credits per 60s
- **`full_ownership`**: 14 credits per 60s

*Duration Rule:* Generations cover up to 60s of audio; longer generations bill proportionally for each started 60-second block (`Math.ceil(duration_sec / 60) * base_cost`).

---

## 🔒 Security Threat Model

Detailed in [SECURITY.md](SECURITY.md):
- **API Key Zero Knowledge:** Raw keys are never stored; only SHA-256 hashes and non-secret prefixes are persisted.
- **Race Condition Prevention:** Account-level critical section locks (`AccountLock`) guarantee deterministic limit checks.
- **SSRF Hardening:** Validates target IPs against private and link-local ranges, rejecting cloud metadata queries (`169.254.169.254`).
- **Webhook Authenticity & Freshness:** HMAC-SHA256 signatures with timestamp checks prevent packet tampering and replay attacks.
- **Tenant Isolation:** Foreign resource lookups return `404 Not Found` to prevent account ID enumeration.
