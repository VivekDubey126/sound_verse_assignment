import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import type { AuditLogEntry } from '../types';

export interface AuditOpts {
  accountId: string;
  actorType: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
}

/**
 * Record an audit log entry. Fire-and-forget by default.
 */
export async function logAudit(opts: AuditOpts): Promise<void> {
  try {
    const db = getDb();
    const entry: Partial<AuditLogEntry> = {
      id: uuid(),
      account_id: opts.accountId,
      actor_type: opts.actorType,
      actor_id: opts.actorId || null,
      action: opts.action,
      resource_type: opts.resourceType,
      resource_id: opts.resourceId || null,
      details: JSON.stringify(opts.details || {}),
      ip_address: opts.ipAddress || null,
      created_at: new Date().toISOString(),
    };
    await db('audit_log').insert(entry);
  } catch (err) {
    console.error('[AUDIT] Failed to log:', err);
  }
}

/**
 * Get audit log entries for an account.
 */
export async function getAuditLog(
  accountId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<AuditLogEntry[]> {
  const db = getDb();
  const limit = opts.limit || 50;
  const offset = opts.offset || 0;

  return db<AuditLogEntry>('audit_log')
    .where('account_id', accountId)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .offset(offset);
}

