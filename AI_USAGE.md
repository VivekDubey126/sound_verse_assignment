# AI Assistance Disclosure (AI_USAGE.md)

As required by the assignment guidelines, this document discloses how AI coding assistants were leveraged, what was delegated, what was reviewed line by line, and concrete instances where AI suggestions were corrected.

---

## 1. What was Delegated
- Scaffolding repetitive schemas, database migration files, and boilerplate Express middleware structures.
- Generating OpenAPI 3.0 YAML definitions based on route specifications.
- Writing test case templates for HTTP endpoints and supertest calls.

---

## 2. What was Reviewed & Crafted Line-by-Line
- **Concurrency & Ledger Logic:** The balance check, parallel limit check, and credit deduction flow in `src/services/generations.ts` and `src/services/metering.ts`. Ensuring that credit deductions write append-only records rather than mutating a mutable counter.
- **SSRF Range Validation:** `src/utils/ssrf.ts` was audited to verify that the IPv4 bitwise checks properly account for unsigned integers (`>>> 0`) and block `169.254.0.0/16` and link-local ranges without leaking internal IP addresses.
- **Idempotency Locking State Machine:** Verifying that requests in flight return `409 Conflict` rather than hanging or returning blank responses.

---

## 3. Concrete Cases Where the AI was Wrong or Subtly Off

### Case 1: In-Flight Idempotency Race Condition
- **AI Initial Suggestion:** The initial AI-generated idempotency middleware checked if the record existed; if not, it inserted the record with status `200` after the handler completed.
- **The Bug:** If two identical requests with the same `Idempotency-Key` arrived simultaneously (e.g. Scenario 6), both requests passed the `find` check before either finished, causing duplicate generation jobs and double-billing.
- **The Correction:** Introduced an initial insertion of a locked idempotency stub with a DB unique constraint `(account_id, idempotency_key)`. The second in-flight request trips the constraint or detects `locked = 1` and returns `409 Conflict` (`idempotency_key_in_progress`).

### Case 2: Sub-Minute Audio Duration Cost Calculation
- **AI Initial Suggestion:** The AI wrote duration unit pricing as `Math.floor(durationSec / 60)`.
- **The Bug:** For a 30-second audio clip, `Math.floor(30 / 60)` evaluated to `0`, causing 30-second generations to be billed 0 credits!
- **The Correction:** Changed to `Math.ceil(durationSec / 60)`. One generation covers up to 60 seconds; every started 60-second window costs 1 license unit, properly billing 1 unit for 30s, and 2 units for 65s.

### Case 3: Ledger Refund on Mid-Job Provider Failure
- **AI Initial Suggestion:** When the AI music model failed or timed out midway through processing, the AI initially attempted to `DELETE` or `UPDATE` the original debit record in `usage_ledger`.
- **The Bug:** Modifying historical transactions violates the financial requirement of an immutable, append-only ledger and breaks audit reconciliation against bank or credit statements.
- **The Correction:** Preserved the original debit row intact and appended a compensating credit row with negative credits (`credits: -chargeAmount`) and `description: "Refund: Generation failed"`. Net billing reconciles to 0 credits while preserving complete historical auditability.

### Case 4: Multi-Tenant Team Membership & Invite Auto-Creation Isolation Bug
- **AI Initial Suggestion:** The initial authentication service (`src/services/accounts.js`) coupled user identity and billing account/workspace 1:1 in a single `accounts` table. When any user signed up or signed in via Google OAuth, the system checked only `accounts.email`. If not found, it generated a new `accountId = uuid()` and created a fresh personal account with `starter` plan.
- **The Bug:** If an organization owner (`noob4coder@gmail.com`) invited an employee (`dubeprince024@gmail.com`) to Account A, when the employee logged in for the first time, the system bypassed the pending invitation, auto-created a brand-new empty workspace, and issued a JWT for that new account. The employee saw an empty dashboard with 0 keys and 0 jobs instead of the owner's organization dashboard.
- **The Correction:**
  1. Decoupled User Identity from Workspaces by introducing a dedicated `memberships` table (`account_id, user_id, email, role, status`).
  2. Implemented invite-aware login/signup: When an employee authenticates, the system first looks up and activates pending memberships for their verified email (`status = 'active'`, `user_id = user.id`).
  3. Added strict constraint: A personal workspace account is created **only if the user has 0 active memberships and 0 pending invites**. Invited team members land directly in the inviter's workspace with their assigned role (`viewer` or `developer`).
  4. Added multi-workspace switcher in the dashboard header if a user belongs to more than one organization.
  5. Enforced server-side RBAC: `viewer` users are prevented from creating/revoking keys, updating plans, or managing members (`403 Forbidden`).

