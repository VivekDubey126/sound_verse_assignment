import { Request, Response, NextFunction } from 'express';
import { requestId as genRequestId } from '../utils/ids';

/**
 * Attach a unique request ID to every request.
 * Also sets the X-Request-Id response header.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) || genRequestId();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

