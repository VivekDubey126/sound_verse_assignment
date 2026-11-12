/**
 * Per-account async mutex for serializing critical sections
 * (credit deduction, parallel limit checks).
 *
 * This ensures that concurrent requests for the same account
 * are serialized through the critical metering path, preventing
 * race conditions on credit/limit checks.
 *
 * Single-process only. For multi-process, use database-level locks.
 */
export class AccountLock {
  private locks = new Map<string, Promise<void>>();

  async acquire<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing operation on this account to complete
    const prev = this.locks.get(accountId) || Promise.resolve();

    let releaseFn: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // Chain our work after the previous work
    this.locks.set(accountId, next);

    // Wait for previous work to finish
    await prev;

    try {
      return await fn();
    } finally {
      releaseFn!();
      // Clean up if we're the last in the chain
      if (this.locks.get(accountId) === next) {
        this.locks.delete(accountId);
      }
    }
  }
}

// Singleton instance
export const accountLock = new AccountLock();

