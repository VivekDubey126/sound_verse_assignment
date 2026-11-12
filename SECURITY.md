# Security Policy & Threat Model (SECURITY.md)

This document presents the security threat model for the **Soundverse AI Enterprise API Platform**, identifying primary threat vectors, attacker motivations, system assets, mitigations, and defensive boundaries.

---

## 1. Asset Inventory & Protected Resources
- **Customer Financials & Credit Balance:** Prevention of unauthorized generations, overdrafts, and race-condition double spending.
- **API Key Secrets:** Protection against persistent leaks, rainbow table attacks, and database breach exposure.
- **Internal Infrastructure & Cloud Metadata:** Hardening against outbound SSRF pivot attacks into AWS/GCP instance metadata (`169.254.169.254`).
- **Proprietary Generated Audio Files:** Protection against unauthorized access, indefinite hotlinking, or tampering.
- **Tenant Data Isolation:** Prevention of cross-account data discovery or unauthorized job cancellations.

---

## 2. Threat Vectors & Concrete Mitigations

### 2.1 Server-Side Request Forgery (SSRF) via Webhooks (Scenario 11)
- **Threat Vector:** An attacker registers a webhook pointing to loopback (`127.0.0.1`), RFC 1918 private LAN addresses (`10.0.0.0/8`, `192.168.0.0/16`), or cloud metadata endpoints (`http://169.254.169.254/latest/meta-data/`) to extract IAM instance role tokens or query internal services.
- **Mitigation:**
  - `src/utils/ssrf.js` performs strict CIDR range validation prior to endpoint insertion and before every dispatch attempt.
  - Rejects all IPv4 addresses in private, link-local, loopback, and reserved ranges with `400 Bad Request` (`ssrf_blocked`).
  - DNS pinning prevents Time-Of-Check to Time-Of-Use (TOCTOU) DNS rebinding attacks.

### 2.2 API Key Theft, Leakage & Database Compromise (Scenario 1 & 2)
- **Threat Vector:** Accidental database dump exposure, SQL injection leaks, or key extraction from log files.
- **Mitigation:**
  - **Zero Knowledge Storage:** Raw API keys (`sk_live_...`, `sk_test_...`) are returned strictly once upon generation. Only the SHA-256 hash and a non-secret 16-character prefix are persisted in the database.
  - **Instant Revocation:** Active keys can be immediately revoked. The authorization middleware verifies key validity at request runtime; revoked keys fail on the next millisecond (`401 Unauthorized`).
  - **Scoped RBAC:** Scopes (`generations:write`, `generations:read`) are checked on each endpoint, limiting blast radius if a read key is exposed.

### 2.3 Concurrency Race Conditions & Double Spending (Scenario 4 & 5)
- **Threat Vector:** Adversaries fire dozens of generation requests at the exact same millisecond to bypass monthly allowance checks or parallel job limits.
- **Mitigation:**
  - **Per-Account Mutex & Row Locks:** In-flight check-and-reserve operations are strictly serialized per account (`AccountLock`).
  - **Append-Only Usage Ledger:** Balances are not stored as mutable counter columns subject to lost updates. Usage is computed deterministically from immutable debit and refund records in `usage_ledger`.
  - **Hard Stop Enforcement:** When allowance is exhausted, concurrent excess requests are cleanly rejected (`429 allowance_exceeded`) without model invocation.

### 2.4 Idempotency Bypass & Replay Attacks (Scenario 6)
- **Threat Vector:** Network retries or intentional replay requests causing duplicate audio generations and redundant customer charges.
- **Mitigation:**
  - Every `POST /v1/generations` request accepts an optional `Idempotency-Key` header.
  - Requests are tracked in `idempotency_keys` with a unique constraint on `(account_id, idempotency_key)`.
  - In-flight requests lock the key, returning `409 Conflict` to simultaneous identical calls.
  - Retried requests with the identical payload receive the cached response (`202 Accepted`).
  - Reusing an existing key with altered parameters is rejected with `422 Unprocessable Entity`.

### 2.5 Webhook Payload Tampering & Replay Attacks (Scenario 10)
- **Threat Vector:** Man-in-the-middle attackers intercepting and re-sending legitimate webhook notifications to trigger duplicate customer-side processing.
- **Mitigation:**
  - Payloads are signed with HMAC-SHA256 using a per-endpoint cryptographic secret.
  - Signatures include a UNIX timestamp: `X-Soundverse-Signature: t=1700000000,v1=9f8a...`.
  - Consumers enforce a 5-minute freshness window, rejecting replayed requests.

### 2.6 Cross-Tenant ID Enumeration (Scenario 8)
- **Threat Vector:** Tenant B attempts to access or cancel jobs belonging to Tenant A by brute-forcing generation IDs (`GET /v1/generations/gen_01J9ZK3`).
- **Mitigation:**
  - All queries enforce a strict `WHERE account_id = ?` predicate.
  - If a job exists but belongs to a different account, the platform returns `404 Not Found` rather than `403 Forbidden`, completely denying existence confirmation.

### 2.7 Stolen or Leaked Audio URLs
- **Threat Vector:** Unauthorized parties intercepting audio links to stream proprietary songs without license rights.
- **Mitigation:**
  - Storage URLs are signed using HMAC-SHA256 with an explicit expiration timestamp (`?expires=...&signature=...`).
  - Tampered signatures or expired timestamps return `403 Forbidden`.

---

## 3. Defense-in-Depth Summary Matrix

| Defense Layer | Mechanism | Standard Response Code |
|---|---|---|
| Network / Transport | TLS 1.3, strict CORS, rate limit sliding window | `429 Too Many Requests` |
| Authentication | Bearer token SHA-256 lookup, revocation check | `401 Unauthorized` |
| Authorization | Scope verification (`generations:write/read`) | `403 Forbidden` |
| Idempotency | DB unique constraint, in-flight mutex | `409 Conflict` / `422 Unprocessable` |
| Concurrency Control | Mutex serialization & atomic write transactions | Deterministic `202` or `429` |
| Accounting | Append-only ledger debit/credit reconciliation | Zero financial drift |
| Webhook Security | SSRF CIDR block, HMAC-SHA256 timestamps | `400 Bad Request` |
