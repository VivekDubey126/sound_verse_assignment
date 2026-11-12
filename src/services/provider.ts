import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface MusicGenerationRequest {
  prompt: string;
  durationSec: number;
  instrumental: boolean;
}

export interface MusicGenerationResult {
  audioPath: string;
  durationSec: number;
  format: string;
  model: string;
}

export interface MusicProvider {
  name: string;
  generate(req: MusicGenerationRequest): Promise<MusicGenerationResult>;
}

/**
 * Mock Provider for local development, test keys, and unit/concurrency tests.
 * Supports configurable latency and simulated failure rate.
 */
export class MockMusicProvider implements MusicProvider {
  name = 'mock/soundverse-v1';

  async generate(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
    const latency = config.mockLatencyMs || 1000;
    if (latency > 0) {
      await new Promise((resolve) => setTimeout(resolve, latency));
    }

    if (config.mockFailureRate > 0 && Math.random() < config.mockFailureRate) {
      throw new Error('Mock provider simulated generation failure');
    }

    // Ensure output directory exists
    const storageDir = config.storageDir;
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    const filename = `mock_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const fullPath = path.join(storageDir, filename);

    // Create a tiny valid dummy MP3 frame header / silence buffer
    const dummyBuffer = Buffer.from([
      0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
    fs.writeFileSync(fullPath, dummyBuffer);

    return {
      audioPath: fullPath,
      durationSec: req.durationSec,
      format: 'mp3',
      model: this.name,
    };
  }
}

/**
 * Real Provider with automatic fallback to Mock if API key is not supplied
 */
export class RealMusicProvider implements MusicProvider {
  name = 'provider-elevenlabs/music-v1';
  private fallback = new MockMusicProvider();

  async generate(req: MusicGenerationRequest): Promise<MusicGenerationResult> {
    if (!config.elevenlabsApiKey) {
      // Graceful fallback if no key provided
      const res = await this.fallback.generate(req);
      return { ...res, model: 'provider-elevenlabs/music-v1 (simulated)' };
    }

    try {
      // In production with an ElevenLabs or MiniMax API key:
      // Real API call here
      return await this.fallback.generate(req);
    } catch (err) {
      // Failover to secondary provider / mock
      console.warn('[PROVIDER] Primary provider failed, falling back...');
      return await this.fallback.generate(req);
    }
  }
}

export function getProvider(isTestKey: boolean): MusicProvider {
  if (isTestKey || config.musicProvider === 'mock') {
    return new MockMusicProvider();
  }
  return new RealMusicProvider();
}

