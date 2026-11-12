const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { config } = require('../config');

/**
 * Creates a minimal valid MP3 buffer (silent audio) for mock/test generation.
 * This is a real, valid, playable MP3 file.
 */
function createSilentMp3(storageDir, prefix = 'audio', durationSec = 30) {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
  const fullPath = path.join(storageDir, filename);

  // Build a valid LAME-encoded silent MP3 frame sequence
  // Each frame = 144 * bitrate / sampleRate bytes = 144 * 128000 / 44100 ≈ 417 bytes
  // For 30s at 44100Hz: ~30 * (44100/1152) ≈ 1150 frames
  const frameCount = Math.max(1, Math.ceil((durationSec * 44100) / 1152));
  const frameSize = 417;
  const buf = Buffer.alloc(frameCount * frameSize);

  for (let i = 0; i < frameCount; i++) {
    const offset = i * frameSize;
    // MP3 sync word + MPEG1, Layer3, 128kbps, 44100Hz, Stereo
    buf[offset + 0] = 0xFF;
    buf[offset + 1] = 0xFB;
    buf[offset + 2] = 0x90;
    buf[offset + 3] = 0x00;
    // Rest of frame is zero-padded (silent PCM)
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
 * HUGGING FACE MUSICGEN PROVIDER (Free Inference API)
 * ============================================================
 * Uses model: facebook/musicgen-small (free, no billing required)
 * Requires: HF_TOKEN env var (free READ token from huggingface.co/settings/tokens)
 *
 * Terms: MusicGen is CC-BY-NC 4.0 licensed — non-commercial use only.
 * For commercial use, switch to a commercially-licensed model.
 */
class HuggingFaceMusicProvider {
  constructor() {
    this.name = 'huggingface/musicgen-small';
    this.hfToken = process.env.HF_TOKEN;
    this.model = process.env.HF_MUSIC_MODEL || 'facebook/musicgen-small';
  }

  async generate(req) {
    if (!this.hfToken) {
      throw new Error('HF_TOKEN environment variable is not set. Get a free token at huggingface.co/settings/tokens');
    }

    const { InferenceClient } = require('@huggingface/inference');
    const hf = new InferenceClient(this.hfToken);

    const prompt = this._buildPrompt(req);
    console.log(`[HuggingFace] Generating music: model=${this.model}, prompt="${prompt.slice(0, 80)}..."`);

    // textToAudio returns a Blob on success
    const audioBlob = await hf.textToAudio({
      model: this.model,
      inputs: prompt,
    });

    // Convert Blob → Buffer → save to disk
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    if (!fs.existsSync(config.storageDir)) {
      fs.mkdirSync(config.storageDir, { recursive: true });
    }

    const filename = `hf_musicgen_${Date.now()}.wav`;
    const audioPath = path.join(config.storageDir, filename);
    fs.writeFileSync(audioPath, audioBuffer);

    console.log(`[HuggingFace] Audio saved: ${audioPath} (${audioBuffer.length} bytes)`);

    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'wav',
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
    } else {
      // Default real provider is HuggingFace if HF_TOKEN present, else Lyria
      this._impl = process.env.HF_TOKEN
        ? new HuggingFaceMusicProvider()
        : process.env.GEMINI_API_KEY
          ? new GoogleLyriaProvider()
          : null;
    }

    this.name = this._impl ? this._impl.name : 'mock/primary-fallback';
    this.timeoutMs = 65000;
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
  getProvider,
};
