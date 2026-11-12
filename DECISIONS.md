# Architecture & Engineering Decisions (DECISIONS.md)

This document outlines the architectural decisions, trade-offs, assumptions, scenario behaviors, and explicit scope cuts for the **Soundverse AI Enterprise API Platform**.

---

## 1. Top Architectural Decisions

### Decision 1: Concurrency Control Strategy for Metering & Parallel Limits
- **Options Considered:**
  1. Optimistic concurrency with row versioning (`retry on conflict`).
  2. Database row-level locks (`SELECT ... FOR UPDATE`).
  3. Per-account asynchronous mutex queue (`AccountLock`) serializing credit deductions and in-flight job checks.
- **Choice:** Per-account mutex lock (`AccountLock`) wrapping SQLite atomic write transactions.
- **Trade-off:** Requests across *different* accounts run concurrently and completely in parallel without blocking each other. Requests within the *same* account undergo a microsecond critical section check before booking credits and queuing jobs.
- **What Would Change Our Mind:** If a single account routinely fired tens of thousands of requests per second across a distributed Kubernetes cluster, we would transition to a Redis-based distributed token bucket / Redlock or PostgreSQL advisory locks.

---

### Decision 2: API Key Storage, Cryptographic Hashing & Verification
- **Options Considered:**
  1. Storing plaintext API keys.
  2. Storing bcrypt or argon2 hashes.
  3. Storing SHA-256 hashes alongside plaintext prefixes (`sk_live_...`, `sk_test_...`).
- **Choice:** SHA-256 digest + public prefix.
- **Trade-off:** Bcrypt adds 50–100ms CPU overhead per incoming API call, creating unacceptable latency at high throughput. SHA-256 is constant-time, executes in <0.1ms, and is cryptographically secure given that keys possess 160+ bits of entropy (`crypto.randomBytes(24)`).
- **What Would Change Our Mind:** If keys had low user-chosen entropy like passwords, we would require a slow, salted hashing algorithm like Argon2id.

---

### Decision 3: Idempotency State Machine & Cache Invalidation
- **Options Considered:**
  1. Standard HTTP client-side caching (`Cache-Control`, `ETag`).
  2. In-memory LRU cache of recently processed requests.
  3. Database-backed `idempotency_keys` table with request body hashing, 24-hour TTL, and atomic in-flight locking.
- **Choice:** Database-backed `idempotency_keys` table with SHA-256 request body verification.
- **Behavior:**
  - **First call:** Acquires lock (`locked = 1`), executes request, stores response code and body, releases lock (`locked = 0`).
  - **Concurrent call (same key):** Detects `locked = 1` and returns `409 Conflict` (`idempotency_key_in_progress`).
  - **Retry call (same key, same body):** Returns cached response (`202 Accepted` with original job payload).
  - **Mismatched body (same key, altered parameters):** Returns `422 Unprocessable Entity` (`idempotency_key_reuse`).
- **What Would Change Our Mind:** In a global multi-region deployment, idempotency locks would be stored in an in-memory key-value store with native TTLs (Redis).

---

### Decision 4: Webhook Security, Delivery & SSRF Mitigation
- **Options Considered:**
  1. Direct unvalidated HTTP POST dispatch to user-provided URLs.
  2. IP address resolution and strict CIDR blacklist validation before registration and delivery.
- **Choice:** CIDR parsing blocking loopback (`127.0.0.0/8`, `::1`), RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and AWS/GCP/Azure link-local metadata endpoints (`169.254.169.254`).
- **Payload Signing:** Payloads are signed using HMAC-SHA256 (`X-Soundverse-Signature: t=...,v1=...`) with timestamp validation to defeat replay attacks.
- **Retry Policy:** Exponential backoff with jitter across 5 retries (10s, 30s, 90s, 270s, 810s).
- **What Would Change Our Mind:** If webhook delivery volume reached millions of events per hour, we would offload deliveries to a dedicated message broker (Kafka or AWS SQS) and worker fleet.

---

### Decision 5: Plan Downgrades Mid-Month (Scenario 12)
- **Options Considered:**
  1. Grandfathering excess usage until next billing cycle.
  2. Immediate hard-stop if used credits exceed the new plan limit.
- **Choice:** Immediate hard stop.
- **Rationale:** If an account used 1,500 credits on Growth and downgrades mid-month to Starter (allowance = 200), their usage immediately exceeds their new tier limit. Subsequent generation requests are rejected with `429 Too Many Requests` (`allowance_exceeded`) until the next monthly billing cycle resets.
- **What Would Change Our Mind:** If business rules specified grandfathered overages with proration invoicing at end of month.

---

### Decision 6: Polling Requests vs Parallel Generation Limit (Scenario 14)
- **Options Considered:**
  1. Counting all API requests (GET and POST) toward the parallel generation limit.
  2. Isolating parallel limits strictly to active music generation jobs (`queued`, `running`).
- **Choice:** Parallel limits apply strictly to active generation jobs; GET status polling requests are rate-limited only by hourly/daily request limits, never by the generation parallel limit.
- **Rationale:** Blocking status polling requests while at the parallel limit would prevent clients from discovering when jobs finish, creating a deadlock.

---

### Decision 7: Resilient Music Provider with Automatic Failover
- **Options Considered:**
  1. Hardcoding a single AI music generation vendor.
  2. Provider abstraction layer (`ResilientMusicProvider`) with primary model timeout, error detection, and automatic failover to a backup provider.
- **Choice:** Resilient provider with configurable primary and secondary models.
- **Rationale:** External AI model APIs experience latency spikes and transient outages. When the primary provider exceeds timeout or throws a 5xx error, the platform automatically routes the job to the secondary provider without failing the customer's request.
- **What Would Change Our Mind:** If legal/licensing rights between providers were fundamentally incompatible for specific customer tiers.

---

### Decision 8: Database Engine & Zero-Dependency Portability
- **Options Considered:**
  1. PostgreSQL requiring a live external container/cluster.
  2. C++ native add-on SQLite drivers (`better-sqlite3`).
  3. Node.js built-in `node:sqlite` (`DatabaseSync`) in WAL mode.
- **Choice:** Node.js native `node:sqlite` (`DatabaseSync`).
- **Rationale:** Guarantees instant zero-dependency execution across any Windows, macOS, or Linux environment without requiring C++ build tools or external database containers. Runs in Write-Ahead Logging (`WAL`) mode with full ACID transaction guarantees.
- **What Would Change Our Mind:** Multi-instance distributed deployments requiring shared networked storage, which would mandate PostgreSQL.

---

## 2. Clarified Assumptions Where the Brief Was Unclear

1. **Parallel Limit Handling (Reject vs Queue):**
   - *Decision:* Rejection with `HTTP 429` (`parallel_limit_reached`) and `Retry-After: 5` header.
   - *Reasoning:* Enterprise clients with predictable SLAs require explicit feedback so their own queueing and orchestration layers can govern backpressure, rather than unbounded server-side buffer bloat.
2. **Monthly Allowance Reset:**
   - *Decision:* Allowance resets on the first day of each calendar month. Unused credits expire and do not roll over.
3. **Cross-Tenant Security:**
   - *Decision:* When Account B attempts to access a job belonging to Account A via `GET /v1/generations/:id`, the API returns `HTTP 404 Not Found` rather than `403 Forbidden`. This completely prevents attackers from enumerating valid job IDs across foreign accounts.
4. **Duration Billing Increments:**
   - *Decision:* Audio generations up to 60 seconds consume 1 license unit. Longer generations cost an additional license unit for each started 60-second increment (`Math.ceil(duration_sec / 60) * base_cost`). A 30s royalty-free track costs 1 credit; a 65s royalty-free track costs 2 credits.
5. **Expiring Signed URLs:**
   - *Decision:* Resulting audio URLs include HMAC-SHA256 signatures with UNIX expiry timestamps (`?expires=...&signature=...`). Direct access to unexpired or altered URLs is denied (`403 Forbidden`).

---

## 3. Chosen Behavior for Each Acceptance Scenario (1–14)

| Scenario | Chosen Behavior | Status Code & Error Code |
|---|---|---|
| **1. API Key Secret Concealment & Scopes** | Secret displayed once at creation; GET/LIST endpoints only return `key_prefix`. Scopes checked per route. | `403 Forbidden` (`insufficient_scope`) |
| **2. Key Revocation Immediate Effect** | Checked at runtime on every request; revocation blocks the next immediate millisecond. | `401 Unauthorized` (`invalid_api_key`) |
| **3. Zero-Downtime Key Rotation** | Rotating key returns new secret; old key remains active for an overlap grace period or is retired cleanly. | `200 OK` on new key; `401` on retired |
| **4. 20 Instant Requests at Parallel Limit (Limit = 3)** | Exactly 3 requests accepted; exactly 17 rejected atomically. | `202 Accepted` for 3; `429 parallel_limit_reached` for 17 |
| **5. 5 Credits Left, 10 Instant Requests** | Exactly 5 requests accepted; exactly 5 rejected with hard stop. | `202 Accepted` for 5; `429 allowance_exceeded` for 5 |
| **6. Idempotency Retries & Body Mismatch** | Concurrent in-flight returns 409; identical retry returns cached 202; altered body returns 422. | `409 Conflict`, `202 Accepted`, `422 Unprocessable` |
| **7. Mid-Job Model Failure** | Compensating negative ledger entry created immediately; net credit cost refunded to 0. | Compensating refund in `usage_ledger` |
| **8. Cross-Account Job Access** | Foreign job query scoped by `account_id` returns 404 to block ID enumeration. | `404 Not Found` (`generation_not_found`) |
| **9. Test Key Quickstart Flow** | Test keys invoke mock provider; 0 credits deducted; generation succeeds. | `202 Accepted`, `credits_charged: 0` |
| **10. Webhook Down & Replay Attack** | Deliveries retried with exponential backoff; payloads older than 5 minutes rejected as replay. | Webhook verification fails freshness check |
| **11. Webhook SSRF Metadata Attack** | IP parsing detects cloud metadata address (`169.254.169.254`) and rejects registration. | `400 Bad Request` (`ssrf_blocked`) |
| **12. Growth to Starter Mid-Month Downgrade** | New limits enforce immediately. Used (1,500) > Allowance (200), triggers immediate hard stop. | `429 Too Many Requests` (`allowance_exceeded`) |
| **13. Starter Requests Full Ownership License** | Starter plan license whitelist checked; full_ownership rejected. | `403 Forbidden` (`license_not_available`) |
| **14. Polling While at Parallel Limit** | GET `/v1/generations/:id` status requests never consume generation slots and always succeed. | `200 OK` |

---

## 4. Scope Cuts: What We Chose Not to Build ("Could Haves")

As directed by the project constraints, we focused entirely on making every **Must Have** and **Should Have** production-ready and provably concurrency-safe, explicitly cutting the optional "Could Haves":

1. **A TypeScript or Python SDK:**
   - *Rationale:* The OpenAPI 3.0 specification (`openapi.yaml`) serves as the single source of truth for the public contract. Client SDKs add maintenance overhead without altering platform correctness. Developers can generate SDKs using standard open-source tools (`openapi-generator`).
2. **Overage Billing through Stripe in Test Mode:**
   - *Rationale:* Enterprise B2B agreements typically bill on monthly net-30 invoicing or contracted credit packages. We enforce strict plan limits via the hard stop mechanism and ledger records rather than taking on a third-party payment gateway sandbox dependency.
3. **An Admin View to Change an Account's Plan:**
   - *Rationale:* Account plans can be dynamically updated via the self-serve developer dashboard and the authenticated API endpoint (`POST /dashboard/plan`) without requiring redeployments or a separate admin application.
4. **Exposing the API as an MCP (Model Context Protocol) Server:**
   - *Rationale:* Our priority was delivering a secure, production-grade HTTP/REST platform with provable concurrency guarantees, HMAC webhooks, and audit logging.
