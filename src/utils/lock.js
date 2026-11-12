class AccountLock {
  constructor() {
    this.locks = new Map();
  }

  async acquire(accountId, fn) {
    const prev = this.locks.get(accountId) || Promise.resolve();

    let releaseFn;
    const next = new Promise((resolve) => {
      releaseFn = resolve;
    });

    this.locks.set(accountId, next);
    await prev;

    try {
      return await fn();
    } finally {
      releaseFn();
      if (this.locks.get(accountId) === next) {
        this.locks.delete(accountId);
      }
    }
  }
}

const accountLock = new AccountLock();
module.exports = { accountLock };

