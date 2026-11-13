const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { config } = require('../config');

/**
 * Creates an audible melodic audio buffer (synthesized acoustic arpeggio track)
 * for mock/test generation so the audio is genuinely audible when played.
 */
function createSilentMp3(storageDir, prefix = 'audio', durationSec = 30) {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
  const fullPath = path.join(storageDir, filename);

  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * (durationSec || 30));
  const dataSize = numSamples * 2;
  const totalSize = 44 + dataSize;
  const buf = Buffer.alloc(totalSize);

  // WAV container compatible with standard audio elements
  buf.write('RIFF', 0);
  buf.writeUInt32LE(totalSize - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // Mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  // Pleasant harmonic acoustic chord progression (C -> Am -> F -> G)
  const chordProgression = [
    [261.63, 329.63, 392.00], // C
    [220.00, 261.63, 329.63], // Am
    [174.61, 220.00, 261.63], // F
    [196.00, 246.94, 293.66], // G
  ];

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const chordIdx = Math.floor(t / 2) % chordProgression.length;
    const chord = chordProgression[chordIdx];
    const noteIdx = Math.floor(t * 4) % chord.length;
    const freq = chord[noteIdx];
    const noteTime = (t * 4) % 1.0;
    const env = Math.exp(-noteTime * 4.0); // Acoustic pluck envelope
    // Rich harmonic timbre
    const wave = Math.sin(2 * Math.PI * freq * t) * 0.5 +
                 Math.sin(4 * Math.PI * freq * t) * 0.25 +
                 Math.sin(6 * Math.PI * freq * t) * 0.12;
    const sample = Math.max(-1, Math.min(1, wave * env * 0.65));
    buf.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
  }

  fs.writeFileSync(fullPath, buf);
  return fullPath;
}

/**
 * Save audio from a URL or base64 buffer to local disk
 */
async function saveAudioFromUrl(url, storageDir, prefix) {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  const filename = `${prefix}_${Date.now()}.mp3`;
  const fullPath = path.join(storageDir, filename);

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(fullPath);
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(fullPath);
      });
    }).on('error', (err) => {
      fs.unlink(fullPath, () => {});
      reject(err);
    });
  });
}

/**
 * ============================================================
 * GOOGLE LYRIA PROVIDER (via Gemini API Interactions endpoint)
 * ============================================================
 * Uses model: lyria-3-clip-preview (30s clips, fast generation)
 * Falls back to lyria-3.5 for full-length tracks.
 *
 * API endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions
 * Auth: x-goog-api-key header
 */
class GoogleLyriaProvider {
  constructor() {
    this.name = 'google/lyria-3-clip-preview';
    this.apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    this.timeoutMs = 60000; // Lyria can take up to 60s
  }

  async generate(req) {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    // Choose model: use clip-preview for ≤30s, full model for longer
    const model = req.durationSec <= 30 ? 'lyria-3-clip-preview' : 'lyria-3.5';

    // Build a rich prompt including duration, style, and mood hints
    const prompt = this._buildPrompt(req);

    console.log(`[Lyria] Generating music: model=${model}, prompt="${prompt.slice(0, 80)}..."`);

    const body = JSON.stringify({
      model,
      input: prompt,
    });

    const result = await this._fetchWithTimeout(body, this.timeoutMs);
    
    // Extract audio data from response
    const audioData = result?.interaction?.output_audio?.data
      || result?.outputAudio?.data
      || result?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!audioData) {
      console.error('[Lyria] Response structure:', JSON.stringify(result, null, 2).slice(0, 500));
      throw new Error('Lyria API did not return audio data in expected format');
    }

    // Decode base64 and save to disk
    const audioBuffer = Buffer.from(audioData, 'base64');
    if (!fs.existsSync(config.storageDir)) {
      fs.mkdirSync(config.storageDir, { recursive: true });
    }
    const filename = `lyria_${Date.now()}.mp3`;
    const audioPath = path.join(config.storageDir, filename);
    fs.writeFileSync(audioPath, audioBuffer);

    console.log(`[Lyria] Audio saved: ${audioPath} (${audioBuffer.length} bytes)`);

    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: `google/${model}`,
    };
  }

  _buildPrompt(req) {
    let prompt = req.prompt || 'An uplifting instrumental music track';

    // Add duration hint
    if (req.durationSec) {
      prompt += `. Target duration: ${req.durationSec} seconds.`;
    }

    // Add instrumental flag
    if (req.instrumental) {
      prompt += ' Instrumental only, no vocals or lyrics.';
    }

    // Add license context (affects style clarity)
    if (req.license === 'sync') {
      prompt += ' Suitable for video sync and commercial use.';
    } else if (req.license === 'full_ownership') {
      prompt += ' High-production quality, broadcast-ready.';
    }

    return prompt;
  }

  _fetchWithTimeout(body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Api-Revision': '2026-05-20',
          'x-goog-api-key': this.apiKey,
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const timeoutHandle = setTimeout(() => {
        req.destroy();
        reject(new Error(`Google Lyria API timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          clearTimeout(timeoutHandle);
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(new Error(`Lyria API Error ${res.statusCode}: ${JSON.stringify(parsed?.error || parsed)}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`Failed to parse Lyria API response: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}

/**
 * ============================================================
 * REPLICATE PROVIDER — meta/musicgen (Free $5 credits on signup)
 * ============================================================
 * Model: meta/musicgen (hosted on replicate.com)
 * Free tier: $5 credits on signup at replicate.com/account
 * Runs async: submit job → poll until complete → download audio
 *
 * Terms: MusicGen is CC-BY-NC 4.0 (non-commercial).
 * For commercial licenses use a commercially cleared model.
 */
class ReplicateMusicProvider {
  constructor() {
    this.name = 'replicate/meta-musicgen';
    this.apiToken = process.env.REPLICATE_API_TOKEN;
    this.modelVersion = process.env.REPLICATE_MUSICGEN_VERSION ||
      'b05b1dff1d8c6dc63d14b0cdb42135378dcb87f6373b0d3d341ede46e59e2b38';
    this.timeoutMs = 120000;
  }

  async generate(req) {
    if (!this.apiToken) {
      throw new Error('REPLICATE_API_TOKEN not set. Get free credits at replicate.com/account');
    }

    const prompt = req.prompt || 'uplifting instrumental music';
    const duration = Math.min(req.durationSec || 30, 30); // musicgen free max 30s
    console.log(`[Replicate] Generating: prompt="${prompt.slice(0, 70)}", duration=${duration}s`);

    // 1. Submit prediction
    const submitBody = JSON.stringify({
      version: this.modelVersion,
      input: {
        prompt: prompt + (req.instrumental ? ', instrumental, no vocals' : ''),
        model_version: 'stereo-small',
        output_format: 'mp3',
        duration,
        normalization_strategy: 'peak',
      },
    });

    const submitRes = await this._httpsRequest('POST', '/v1/predictions', submitBody);
    if (!submitRes.id) {
      throw new Error(`Replicate submission failed: ${JSON.stringify(submitRes).slice(0, 200)}`);
    }

    console.log(`[Replicate] Job submitted: ${submitRes.id}, polling...`);

    // 2. Poll until complete
    const startTime = Date.now();
    while (Date.now() - startTime < this.timeoutMs) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await this._httpsRequest('GET', `/v1/predictions/${submitRes.id}`);

      if (status.status === 'succeeded') {
        const audioUrl = Array.isArray(status.output) ? status.output[0] : status.output;
        if (!audioUrl) throw new Error('Replicate returned no audio URL');
        console.log(`[Replicate] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
        const audioPath = await saveAudioFromUrl(audioUrl, config.storageDir, 'replicate');
        return { audioPath, durationSec: req.durationSec, format: 'mp3', model: this.name };
      }

      if (status.status === 'failed' || status.status === 'canceled') {
        throw new Error(`Replicate job ${status.status}: ${status.error || 'unknown'}`);
      }
    }
    throw new Error('Replicate timed out after 120s');
  }

  _httpsRequest(method, path, body) {
    return new Promise((resolve, reject) => {
      const https = require('https');
      const opts = {
        hostname: 'api.replicate.com',
        path,
        method,
        headers: { 'Authorization': `Bearer ${this.apiToken}`, 'Content-Type': 'application/json' },
      };
      if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
      const req = https.request(opts, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d.slice(0, 100))); } });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}

/**
 * ============================================================
 * FAL.AI / MiniMax Music Provider (Alternative real provider)
 * ============================================================
 */
class FalMiniMaxProvider {
  constructor() {
    this.name = 'fal-ai/minimax-music';
    this.apiKey = process.env.FAL_KEY;
    this.timeoutMs = 120000;
  }

  async generate(req) {
    if (!this.apiKey) {
      throw new Error('FAL_KEY environment variable is not set');
    }

    console.log(`[MiniMax] Generating music via fal.ai...`);

    const body = JSON.stringify({
      prompt: req.prompt,
      duration: req.durationSec || 30,
      instrumental: req.instrumental !== false,
    });

    const response = await fetch('https://fal.run/fal-ai/minimax-music', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`fal.ai API error ${response.status}: ${err}`);
    }

    const result = await response.json();
    const audioUrl = result?.audio?.url || result?.audio_url;

    if (!audioUrl) {
      throw new Error('fal.ai did not return an audio URL');
    }

    const audioPath = await saveAudioFromUrl(audioUrl, config.storageDir, 'minimax');

    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: this.name,
    };
  }
}

/**
 * ============================================================
 * HUGGING FACE MUSICGEN PROVIDER (Direct REST Inference API)
 * ============================================================
 * Uses model: facebook/musicgen-small via HF inference REST API.
 * Requires: HF_TOKEN with 'Make calls to the serverless Inference API' permission.
 * Token scopes: Go to hf.co/settings/tokens → Edit token → enable Inference scope.
 *
 * Terms: MusicGen is CC-BY-NC 4.0 licensed — non-commercial use only.
 * For commercial use, switch to a commercially-licensed model.
 *
 * NOTE: If your HF token only has repo.content.read scope, generation
 * will fall back to the mock provider automatically. Update the token
 * scope at huggingface.co/settings/tokens to enable inference.
 */
class HuggingFaceMusicProvider {
  constructor() {
    this.model = process.env.HF_MUSIC_MODEL || 'facebook/musicgen-small';
    this.name = `huggingface/${this.model.split('/').pop()}`;
    this.hfToken = process.env.HF_TOKEN;
    this.timeoutMs = 120000; // musicgen-small can take up to 2 min on cold start
  }

  async generate(req) {
    if (!this.hfToken) {
      throw new Error('HF_TOKEN not set. Get a free token at huggingface.co/settings/tokens');
    }

    const prompt = this._buildPrompt(req);
    console.log(`[HuggingFace] Generating: model=${this.model}, prompt="${prompt.slice(0, 80)}..."`);

    // Use the HF router endpoint (new inference routing system)
    const url = `https://router.huggingface.co/hf-inference/models/${this.model}`;
    const body = JSON.stringify({ inputs: prompt });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.hfToken}`,
          'Content-Type': 'application/json',
          'Accept': 'audio/wav, audio/flac, audio/mpeg, application/octet-stream',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      // Check for common token permission error — give a helpful message
      if (response.status === 403 && errText.includes('permissions')) {
        throw new Error(
          'HF token lacks Inference permission. Go to hf.co/settings/tokens, edit your token, ' +
          'and enable "Make calls to the serverless Inference API" under User Permissions.'
        );
      }
      if (response.status === 503) {
        throw new Error(`HF model ${this.model} is loading (cold start). Retry in 20s.`);
      }
      throw new Error(`HF API error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('audio') && !contentType.includes('octet-stream')) {
      const text = await response.text();
      throw new Error(`HF did not return audio (got ${contentType}): ${text.slice(0, 200)}`);
    }

    // Save the audio buffer to disk
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    if (!fs.existsSync(config.storageDir)) {
      fs.mkdirSync(config.storageDir, { recursive: true });
    }

    const ext = contentType.includes('flac') ? 'flac' : contentType.includes('mpeg') ? 'mp3' : 'wav';
    const filename = `hf_${Date.now()}.${ext}`;
    const audioPath = path.join(config.storageDir, filename);
    fs.writeFileSync(audioPath, audioBuffer);

    console.log(`[HuggingFace] Audio saved: ${audioPath} (${audioBuffer.length} bytes, ${ext})`);

    return {
      audioPath,
      durationSec: req.durationSec,
      format: ext,
      model: this.name,
    };
  }

  _buildPrompt(req) {
    let prompt = req.prompt || 'An uplifting instrumental music track';
    if (req.instrumental) prompt += ', instrumental, no vocals';
    if (req.durationSec) prompt += `, ${req.durationSec} seconds`;
    return prompt;
  }
}

/**
 * ============================================================
 * PRIMARY MUSIC PROVIDER — wraps the configured real API
 * ============================================================
 */
class PrimaryMusicProvider {
  constructor() {
    const provider = process.env.MUSIC_PROVIDER || 'mock';

    if (provider === 'lyria' || provider === 'gemini') {
      this._impl = new GoogleLyriaProvider();
    } else if (provider === 'minimax' || provider === 'fal') {
      this._impl = new FalMiniMaxProvider();
    } else if (provider === 'huggingface' || provider === 'hf') {
      this._impl = new HuggingFaceMusicProvider();
    } else if (provider === 'replicate') {
      this._impl = new ReplicateMusicProvider();
    } else {
      // Auto-detect: Replicate > HuggingFace > Lyria
      this._impl = process.env.REPLICATE_API_TOKEN
        ? new ReplicateMusicProvider()
        : process.env.HF_TOKEN
          ? new HuggingFaceMusicProvider()
          : process.env.GEMINI_API_KEY
            ? new GoogleLyriaProvider()
            : null;
    }

    this.name = this._impl ? this._impl.name : 'mock/primary-fallback';
    this.timeoutMs = 120000;
  }

  async generate(req) {
    if (!this._impl) {
      throw new Error('No real music provider configured. Set MUSIC_PROVIDER=lyria and GEMINI_API_KEY.');
    }
    return this._impl.generate(req);
  }
}

/**
 * Backup provider — always uses mock so failover never fails
 */
class BackupMusicProvider {
  constructor() {
    this.name = 'mock/backup-v1';
  }

  async generate(req) {
    console.warn('[Backup] Using silent mock audio as backup provider');
    const audioPath = createSilentMp3(config.storageDir, 'failover', req.durationSec || 30);
    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: this.name,
      failedOver: true,
    };
  }
}

/**
 * Failover orchestrator: tries primary real provider, falls back to backup on failure
 */
class ResilientMusicProvider {
  constructor() {
    this.primary = new PrimaryMusicProvider();
    this.backup = new BackupMusicProvider();
  }

  async generate(req) {
    try {
      const result = await Promise.race([
        this.primary.generate(req),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Primary model timed out (504 Gateway Timeout)')), 65000)
        ),
      ]);
      return result;
    } catch (err) {
      console.warn(`[FAILOVER] Primary provider failed or slow (${err.message}). Activating backup provider...`);
      const backupResult = await this.backup.generate(req);
      return {
        ...backupResult,
        failoverNotice: `Auto-failed over from primary: ${err.message}`,
      };
    }
  }
}

/**
 * Mock provider — for test keys (sk_test_...) and MUSIC_PROVIDER=mock
 * Generates a real, playable, silent MP3 file at zero cost.
 */
class MockMusicProvider {
  constructor() {
    this.name = 'mock/test-v1';
  }

  async generate(req) {
    // Simulate realistic latency (configurable via MOCK_LATENCY_MS)
    const latency = config.mockLatencyMs || 1500;
    await new Promise((resolve) => setTimeout(resolve, latency));

    const audioPath = createSilentMp3(config.storageDir, 'test_mock', req.durationSec || 30);
    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: this.name,
    };
  }
}

/**
 * Provider factory — decides which provider to use based on key type and config
 */
function getProvider(isTestKey) {
  if (isTestKey) {
    return new MockMusicProvider();
  }

  const providerName = process.env.MUSIC_PROVIDER || 'mock';
  if (providerName === 'mock') {
    // Even live keys use mock if MUSIC_PROVIDER=mock is explicitly set
    return new MockMusicProvider();
  }

  // Live keys + real provider configured: use resilient wrapper
  return new ResilientMusicProvider();
}

module.exports = {
  PrimaryMusicProvider,
  BackupMusicProvider,
  ResilientMusicProvider,
  MockMusicProvider,
  GoogleLyriaProvider,
  FalMiniMaxProvider,
  HuggingFaceMusicProvider,
  ReplicateMusicProvider,
  getProvider,
};
