const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/connection');
const { getProvider } = require('./provider');
const { queueWebhookDeliveries, deliverWebhook } = require('./webhooks');
const { refundCredits } = require('./metering');
const { config } = require('../config');

let workerRunning = false;
let workerInterval = null;

async function processNextJob() {
  const db = getDb();
  const job = db.prepare("SELECT * FROM generations WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
  if (!job) return false;

  const now = new Date().toISOString();
  const res = db.prepare("UPDATE generations SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(now, job.id);
  if (res.changes === 0) return false;

  const isTestKey = job.model && job.model.includes('test');
  const provider = getProvider(isTestKey);

  try {
    const result = await provider.generate({
      prompt: job.prompt,
      durationSec: job.duration_sec,
      instrumental: Boolean(job.instrumental),
    });

    const targetFile = `${job.id}.mp3`;
    const targetPath = path.join(config.storageDir, targetFile);

    if (fs.existsSync(result.audioPath) && result.audioPath !== targetPath) {
      fs.copyFileSync(result.audioPath, targetPath);
    }

    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE generations 
      SET status = 'succeeded', output_url = ?, output_duration_sec = ?, output_format = 'mp3', model = ?, completed_at = ?
      WHERE id = ?
    `).run(`/v1/audio/${targetFile}`, result.durationSec, result.model, completedAt, job.id);

    const completed = db.prepare('SELECT * FROM generations WHERE id = ?').get(job.id);
    await queueWebhookDeliveries(completed, 'generation.completed');
    return true;
  } catch (err) {
    const completedAt = new Date().toISOString();
    db.prepare(`
      UPDATE generations 
      SET status = 'failed', error_message = ?, completed_at = ?
      WHERE id = ?
    `).run(err.message, completedAt, job.id);

    if (job.credits_charged > 0) {
      await refundCredits(job.account_id, job.id, job.credits_charged, job.api_key_id);
    }

    const failed = db.prepare('SELECT * FROM generations WHERE id = ?').get(job.id);
    await queueWebhookDeliveries(failed, 'generation.failed');
    return true;
  }
}

async function processPendingWebhooks() {
  const db = getDb();
  const now = new Date().toISOString();
  const pending = db.prepare('SELECT * FROM webhook_deliveries WHERE delivered_at IS NULL AND next_retry_at <= ? LIMIT 5').all(now);
  for (const d of pending) {
    await deliverWebhook(d);
  }
}

function startWorker(intervalMs = 400) {
  if (workerRunning) return;
  workerRunning = true;
  workerInterval = setInterval(async () => {
    try {
      await processNextJob();
      await processPendingWebhooks();
    } catch {}
  }, intervalMs);
}

function stopWorker() {
  if (workerInterval) clearInterval(workerInterval);
  workerRunning = false;
}

module.exports = { startWorker, stopWorker, processNextJob };

