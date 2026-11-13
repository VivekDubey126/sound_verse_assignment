const fs = require('fs');
const path = require('path');
const https = require('https');
const { config } = require('../config');

/**
 * Synthesizes an audible acoustic chord progression (C -> Am -> F -> G)
 * Used by MockMusicProvider for test keys and BackupMusicProvider for failover.
 */
function createSyntheticAudio(storageDir, prefix = 'audio', durationSec = 22) {
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
  const fullPath = path.join(storageDir, filename);

  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * (durationSec || 22));
  const dataSize = numSamples * 2;
  const totalSize = 44 + dataSize;
  const buf = Buffer.alloc(totalSize);

  // WAV header
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

  // Harmonic chord progression
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
    const env = Math.exp(-noteTime * 4.0);
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
 * Primary Production Provider: ElevenLabs Sound & Music Generation API
 */
class ElevenLabsMusicProvider {
  constructor() {
    this.name = 'elevenlabs/sound-generation-v1';
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.timeoutMs = 60000;
  }

  async generate(req) {
    if (!this.apiKey) {
      throw new Error('ELEVENLABS_API_KEY environment variable is not set');
    }

    let rawPrompt = req.prompt || 'Uplifting acoustic guitar melody with warm reverb';
    if (rawPrompt.length > 440) {
      rawPrompt = rawPrompt.slice(0, 437) + '...';
    }
    const promptText = rawPrompt;
    const durationSec = Math.min(Math.max(req.durationSec || 10, 1), 22);

    console.log(`[ElevenLabs] Generating audio: prompt="${promptText.slice(0, 70)}", duration=${durationSec}s`);

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        text: promptText,
        duration_seconds: durationSec,
        prompt_influence: 0.35,
      });

      const options = {
        hostname: 'api.elevenlabs.io',
        path: '/v1/sound-generation',
        method: 'POST',
        headers: {
          'xi-api-key': this.apiKey,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const timer = setTimeout(() => {
        request.destroy();
        reject(new Error('ElevenLabs API request timed out after 60s'));
      }, this.timeoutMs);

      const request = https.request(options, (res) => {
        if (res.statusCode >= 400) {
          let errData = '';
          res.on('data', chunk => errData += chunk);
          res.on('end', () => {
            clearTimeout(timer);
            reject(new Error(`ElevenLabs API returned ${res.statusCode}: ${errData}`));
          });
          return;
        }

        if (!fs.existsSync(config.storageDir)) {
          fs.mkdirSync(config.storageDir, { recursive: true });
        }

        const filename = `eleven_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
        const audioPath = path.join(config.storageDir, filename);
        const fileStream = fs.createWriteStream(audioPath);

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          clearTimeout(timer);
          fileStream.close();
          console.log(`[ElevenLabs] Audio saved successfully: ${audioPath}`);
          resolve({
            audioPath,
            durationSec: req.durationSec,
            format: 'mp3',
            model: this.name,
          });
        });

        fileStream.on('error', (err) => {
          clearTimeout(timer);
          fs.unlink(audioPath, () => {});
          reject(err);
        });
      });

      request.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      request.write(payload);
      request.end();
    });
  }
}

/**
 * Backup Provider: Activates seamlessly if ElevenLabs is down or slow
 */
class BackupMusicProvider {
  constructor() {
    this.name = 'mock/backup-v1';
  }

  async generate(req) {
    console.warn('[Backup] Using synthetic audio as backup provider');
    const audioPath = createSyntheticAudio(config.storageDir, 'failover', req.durationSec || 22);
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
 * Resilient Orchestrator: Calls ElevenLabs, automatically fails over to backup on error/timeout
 */
class ResilientMusicProvider {
  constructor() {
    this.primary = new ElevenLabsMusicProvider();
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
 * Mock Provider: Fast, zero-cost generator for test keys (sk_test_...) and unit tests
 */
class MockMusicProvider {
  constructor() {
    this.name = 'mock/test-v1';
  }

  async generate(req) {
    const latency = config.mockLatencyMs || 100;
    await new Promise((resolve) => setTimeout(resolve, latency));

    const audioPath = createSyntheticAudio(config.storageDir, 'test_mock', req.durationSec || 22);
    return {
      audioPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: this.name,
    };
  }
}

/**
 * Factory: Routes test keys to Mock and live keys to Resilient ElevenLabs provider
 */
function getProvider(isTestKey) {
  if (isTestKey || process.env.MUSIC_PROVIDER === 'mock') {
    return new MockMusicProvider();
  }
  return new ResilientMusicProvider();
}

module.exports = {
  ElevenLabsMusicProvider,
  BackupMusicProvider,
  ResilientMusicProvider,
  MockMusicProvider,
  getProvider,
};
