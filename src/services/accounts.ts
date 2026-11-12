import { getDb } from '../db/connection';
import { uuid } from '../utils/ids';
import { hashPassword, verifyPassword, generateVerificationToken } from '../utils/crypto';
import { BadRequestError, ConflictError, AuthenticationError, NotFoundError } from '../utils/errors';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import type { Account } from '../types';

export async function createAccount(email: string, password: string): Promise<{ account: Account; verificationToken: string }> {
  const db = getDb();

  // Check for existing account
  const existing = await db<Account>('accounts').where('email', email.toLowerCase()).first();
  if (existing) {
    throw new ConflictError('email_taken', 'An account with this email already exists');
  }

  const now = new Date().toISOString();
  const verificationToken = generateVerificationToken();
  const passwordHash = await hashPassword(password);

  // Compute period start (first of current month)
  const periodStart = new Date();
  periodStart.setDate(1);
  periodStart.setHours(0, 0, 0, 0);

  const account: Account = {
    id: uuid(),
    email: email.toLowerCase(),
    password_hash: passwordHash,
    email_verified: 0,
    email_verification_token: verificationToken,
    plan_name: 'sandbox',
    allowance_period_start: periodStart.toISOString(),
    created_at: now,
    updated_at: now,
  };

  await db('accounts').insert(account);

  return { account, verificationToken };
}

export async function verifyEmail(token: string): Promise<Account> {
  const db = getDb();

  const account = await db<Account>('accounts')
    .where('email_verification_token', token)
    .first();

  if (!account) {
    throw new NotFoundError('Verification token');
  }

  if (account.email_verified) {
    return account; // Already verified, idempotent
  }

  await db('accounts')
    .where('id', account.id)
    .update({
      email_verified: 1,
      email_verification_token: null,
      updated_at: new Date().toISOString(),
    });

  return { ...account, email_verified: 1, email_verification_token: null };
}

export async function login(email: string, password: string): Promise<{ token: string; account: Account }> {
  const db = getDb();

  const account = await db<Account>('accounts')
    .where('email', email.toLowerCase())
    .first();

  if (!account) {
    throw new AuthenticationError('Invalid email or password');
  }

  const valid = await verifyPassword(password, account.password_hash);
  if (!valid) {
    throw new AuthenticationError('Invalid email or password');
  }

  const token = jwt.sign(
    { accountId: account.id, email: account.email },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return { token, account };
}

export async function getAccount(accountId: string): Promise<Account> {
  const db = getDb();
  const account = await db<Account>('accounts').where('id', accountId).first();
  if (!account) {
    throw new NotFoundError('Account');
  }
  return account;
}

export async function updatePlan(accountId: string, planName: string): Promise<Account> {
  const db = getDb();

  // Verify plan exists
  const plan = await db('plans').where('name', planName).first();
  if (!plan) {
    throw new BadRequestError('invalid_plan', `Plan '${planName}' does not exist`);
  }

  await db('accounts')
    .where('id', accountId)
    .update({
      plan_name: planName,
      updated_at: new Date().toISOString(),
    });

  return getAccount(accountId);
}

