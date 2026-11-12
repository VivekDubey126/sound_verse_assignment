// ── Shared type definitions ──

export interface Account {
  id: string;
  email: string;
  password_hash: string;
  email_verified: number; // SQLite boolean (0/1)
  email_verification_token: string | null;
  plan_name: string;
  allowance_period_start: string; // ISO 8601
  created_at: string;
  updated_at: string;
}

export interface Plan {
  name: string;
  display_name: string;
  monthly_allowance: number;
  parallel_generations: number;
  requests_per_hour: number;
  requests_per_day: number;
  licenses_available: string; // JSON array string in SQLite
  beyond_allowance: 'hard_stop' | 'overage' | 'none';
}

export interface ApiKey {
  id: string;
  account_id: string;
  key_prefix: string;
  key_hash: string;
  name: string | null;
  mode: 'test' | 'live';
  scopes: string; // JSON array string
  is_revoked: number;
  last_used_at: string | null;
  created_at: string;
}

export interface Generation {
  id: string;
  account_id: string;
  api_key_id: string;
  prompt: string;
  duration_sec: number;
  license: string;
  instrumental: number;
  metadata: string; // JSON string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  model: string | null;
  credits_charged: number;
  output_url: string | null;
  output_duration_sec: number | null;
  output_format: string;
  error_message: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface UsageLedgerEntry {
  id: string;
  account_id: string;
  generation_id: string | null;
  credits: number;
  license: string | null;
  description: string | null;
  period_start: string;
  period_end: string;
  api_key_id: string | null;
  created_at: string;
}

export interface WebhookEndpoint {
  id: string;
  account_id: string;
  url: string;
  secret: string;
  events: string; // JSON array string
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_endpoint_id: string;
  generation_id: string | null;
  event_type: string;
  payload: string; // JSON string
  response_status: number | null;
  response_body: string | null;
  attempt: number;
  max_attempts: number;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  account_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: string; // JSON string
  ip_address: string | null;
  created_at: string;
}

export interface IdempotencyRecord {
  id: string;
  account_id: string;
  idempotency_key: string;
  request_path: string;
  request_body_hash: string;
  response_status: number | null;
  response_body: string | null; // JSON string
  generation_id: string | null;
  locked: number;
  created_at: string;
  expires_at: string;
}

// ── API response shapes ──

export interface GenerationResponse {
  id: string;
  status: string;
  license: string;
  credits_charged: number;
  prompt: string;
  duration_sec: number;
  instrumental: boolean;
  metadata: Record<string, any>;
  output: {
    audio_url: string | null;
    duration_sec: number | null;
    format: string;
  } | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ErrorResponse {
  error: {
    type: string;
    code: string;
    message: string;
    request_id: string;
  };
}

// ── Auth context attached to requests ──

export interface AuthContext {
  accountId: string;
  account: Account;
  plan: Plan;
}

export interface ApiKeyContext extends AuthContext {
  apiKey: ApiKey;
  keyMode: 'test' | 'live';
  scopes: string[];
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
      apiKeyCtx?: ApiKeyContext;
    }
  }
}

