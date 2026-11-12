import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { getDb } from '../db/connection';
import { AuthenticationError } from '../utils/errors';
import type { Account, Plan } from '../types';

/**
 * JWT-based authentication for dashboard routes.
 * Expects Authorization: Bearer <jwt-token>
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AuthenticationError('Missing or invalid Authorization header');
    }

    const token = authHeader.slice(7);
    let payload: any;

    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw new AuthenticationError('Invalid or expired token');
    }

    const db = getDb();
    const account = await db<Account>('accounts').where('id', payload.accountId).first();
    if (!account) {
      throw new AuthenticationError('Account not found');
    }

    const plan = await db<Plan>('plans').where('name', account.plan_name).first();
    if (!plan) {
      throw new AuthenticationError('Account plan not found');
    }

    req.auth = {
      accountId: account.id,
      account,
      plan,
    };

    next();
  } catch (err) {
    next(err);
  }
}

