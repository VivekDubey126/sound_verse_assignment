import express from 'express';
import cors from 'cors';
import path from 'path';
import { requestIdMiddleware } from './middleware/requestId';
import { errorHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth';
import { v1Router } from './routes/v1';
import { dashboardRouter } from './routes/dashboard';

export function createApp() {
  const app = express();

  // Basic middlewares
  app.use(cors());
  app.use(express.json());
  app.use(requestIdMiddleware);

  // Serve static UI / assets
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // API Routes
  app.use('/auth', authRouter);
  app.use('/v1', v1Router);
  app.use('/dashboard', dashboardRouter);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({
      error: {
        type: 'not_found_error',
        code: 'route_not_found',
        message: 'Endpoint does not exist',
        request_id: (_req as any).requestId || 'unknown',
      },
    });
  });

  // Global Error Handler
  app.use(errorHandler);

  return app;
}

