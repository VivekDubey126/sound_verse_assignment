import fs from 'fs';
import path from 'path';
import { getDb } from '../db/connection';
import { getProvider } from './provider';
import { queueWebhookDeliveries, deliverWebhook } from './webhooks';
import { refundCredits } from './metering';
import { config } from '../config';
import type { Generation, WebhookDelivery } from '../types';

let workerRunning = false;
let workerInterval: NodeJS.Timeout | null = null;

export async function processNextJob(): Promise<boolean> {
  const db = getDb();

  // Atomically select 1 queued job
  const job = await db<Generation>('generations')
    .where('status', 'queued')
    .orderBy('created_at', 'asc')
    .first();

  if (!job) {
    return false;
  }

  const now = new Date().toISOString();

  // Mark running
  const updated = await db('generations')
    .where('id', job.id)
    .where('status', 'queued')
    .update({
      status: 'running',
      started_at: now,
    });

  if (updated === 0) {
    return false; // Another worker or race condition picked it up
  }

  const isTestKey = job.model?.includes('test') || job.model?.includes('mock') || false;
  const provider = getProvider(isTestKey);

  try {
    const result = await provider.generate({
      prompt: job.prompt,
      durationSec: job.duration_sec,
      instrumental: !!job.instrumental,
    });

    // Move audio file to final destination named after generation ID
    const ext = result.format || 'mp3';
    const targetFile = `${job.id}.${ext}`;
    const targetPath = path.join(config.storageDir, targetFile);

    if (fs.existsSync(result.audioPath) && result.audioPath !== targetPath) {
      fs.copyFileSync(result.audioPath, targetPath);
    }

    const completedAt = new Date().toISOString();

    await db('generations')
      .where('id', job.id)
      .update({
        status: 'succeeded',
        output_url: `/v1/audio/${targetFile}`,
        output_duration_sec: result.durationSec,
        output_format: ext,
        model: result.model,
        completed_at: completedAt,
      });

    // Notify webhooks
    const completedJob = await db<Generation>('generations').where('id', job.id).first();
    if (completedJob) {
      await queueWebhookDeliveries(completedJob, 'generation.completed');
    }

    return true;
  } catch (err: any) {
    console.error(`[WORKER] Job ${job.id} failed:`, err.message);
    const completedAt = new Date().toISOString();

    await db('generations')
      .where('id', job.id)
      .update({
        status: 'failed',
        error_message: err.message || 'Generation failed',
        completed_at: completedAt,
      });

    // Refund credits on failure
    if (job.credits_charged > 0) {
      await refundCredits(job.account_id, job.id, job.credits_charged, job.api_key_id);
    }

    const failedJob = await db<Generation>('generations').where('id', job.id).first();
    if (failedJob) {
      await queueWebhookDeliveries(failedJob, 'generation.failed');
    }

    return true;
  }
}

/**
 * Deliver pending webhooks
 */
export async function processPendingWebhooks(): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const pending = await db<WebhookDelivery>('webhook_deliveries')
    .whereNull('delivered_at')
    .where('next_retry_at', '<=', now)
    .limit(10);

  for (const delivery of pending) {
    await deliverWebhook(delivery);
  }
}

export function startWorker(intervalMs: number = 500) {
  if (workerRunning) return;
  workerRunning = true;

  workerInterval = setInterval(async () => {
    try {
      await processNextJob();
      await processPendingWebhooks();
    } catch (e) {
      // Keep worker alive
    }
  }, intervalMs);

  console.log('[WORKER] Background generation & webhook worker started.');
}

export function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  workerRunning = false;
}

