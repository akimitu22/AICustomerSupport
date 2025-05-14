/**
 * StableAudioRecorder.ts
 * 高レベル録音インターフェース
 */
import { EventEmitter } from 'events';

// 仮の型定義（FusionCore, AudioBlobManager, Logger, types）
interface FusionCore {
  initialize: () => Promise<void>;
  startRecording: () => Promise<Blob>;
  stop: () => Promise<Blob>;
  dispose: () => void;
  getRecordingCapabilities: () => CapabilitiesResult & {
    hasBasicRecording: boolean;
    hasStableRecording: boolean;
    recommendedMaxDuration: number;
    hasLongRecording: boolean;
  };
  on: (event: CoreEvent, listener: (...args: any[]) => void) => () => void;
}

interface AudioBlobManager {
  addChunk: (blob: Blob) => void;
  getBlob: () => Blob;
  createMediaSourceUrl: () => Promise<string>;
  dispose: () => void;
}

class Logger {
  constructor(public debug: boolean = false) {}
  info(...args: any[]): void { if (this.debug) console.info('[Recorder][INFO]', ...args); }
  warn(...args: any[]): void { if (this.debug) console.warn('[Recorder][WARN]', ...args); }
  error(...args: any[]): void { console.error('[Recorder][ERROR]', ...args); }
}

interface CapabilitiesResult {
  hasMediaRecorder: boolean;
  isIOS: boolean;
  cpuCores: number;
  hasScriptProcessor: boolean;
}

type CoreEvent =
  | 'speechEnd'
  | 'error'
  | 'processingProgress';

export interface RecordingOptions {
  maxDurationSec?: number;
  autoStop?: boolean;
  chunkSizeSec?: number;
  statusCallback?: (status: RecorderStatus) => void;
}

export type RecorderStatus =
  | { state: 'idle' }
  | { state: 'initializing' }
  | { state: 'ready' }
  | { state: 'recording'; durationMs: number }
  | { state: 'processing'; progress: number }
  | { state: 'complete'; blob: Blob; url: string; durationMs: number }
  | { state: 'error'; message: string; recoverable: boolean };

export class StableAudioRecorder {
  private core: FusionCore;
  private blobManager: AudioBlobManager | null = null;
  private options: Required<RecordingOptions>;
  private status: RecorderStatus = { state: 'idle' };
  private startTime = 0;
  private durationInterval: NodeJS.Timeout | null = null;
  private log: Logger;

  constructor(options: RecordingOptions = {}) {
    this.options = {
      maxDurationSec: 300,
      autoStop: true,
      chunkSizeSec: 60,
      statusCallback: () => {},
      ...options,
    };

    this.log = new Logger(true);

    // 仮のFusionCore実装
    this.core = {
      initialize: async () => {},
      startRecording: async () => new Blob([]),
      stop: async () => new Blob([]),
      dispose: () => {},
      getRecordingCapabilities: () => ({
        hasMediaRecorder: true,
        isIOS: false,
        cpuCores: 4,
        hasScriptProcessor: true,
        hasBasicRecording: true,
        hasStableRecording: true,
        recommendedMaxDuration: 1800,
        hasLongRecording: true,
      }),
      on: (event: CoreEvent, listener: (...args: any[]) => void) => {
        const emitter = new EventEmitter();
        emitter.on(event, listener);
        return () => emitter.off(event, listener);
      },
    };

    const caps = this.core.getRecordingCapabilities();
    if (!caps.hasLongRecording && this.options.maxDurationSec > caps.recommendedMaxDuration) {
      this.log.warn(
        `この環境では長時間録音が不安定です。最大録音時間を${caps.recommendedMaxDuration}秒に制限します`,
      );
      this.options.maxDurationSec = caps.recommendedMaxDuration;
    }

    this.setupEventHandlers();
  }

  async checkAvailability(): Promise<{
    available: boolean;
    hasStableRecording: boolean;
    maxDuration: number;
    errorMessage?: string;
  }> {
    try {
      const caps = this.core.getRecordingCapabilities();

      if (!caps.hasBasicRecording) {
        return {
          available: false,
          hasStableRecording: false,
          maxDuration: 0,
          errorMessage: 'この環境では録音機能がサポートされていません',
        };
      }

      let hasPermission = false;
      try {
        const stream = await globalThis.navigator?.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
        hasPermission = true;
      } catch (err) {
        return {
          available: false,
          hasStableRecording: false,
          maxDuration: 0,
          errorMessage: 'マイクへのアクセス権限がありません',
        };
      }

      return {
        available: hasPermission,
        hasStableRecording: caps.hasStableRecording,
        maxDuration: caps.recommendedMaxDuration,
      };
    } catch (err) {
      return {
        available: false,
        hasStableRecording: false,
        maxDuration: 0,
        errorMessage: '録音機能の確認中にエラーが発生しました',
      };
    }
  }

  async initialize(): Promise<void> {
    if (this.status.state !== 'idle' && this.status.state !== 'error') {
      throw new Error('すでに初期化されています');
    }

    this.updateStatus({ state: 'initializing' });

    try {
      await this.core.initialize();

      this.blobManager = {
        addChunk: () => {},
        getBlob: () => new Blob([]),
        createMediaSourceUrl: async () => '',
        dispose: () => {},
      };

      this.updateStatus({ state: 'ready' });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.updateStatus({
        state: 'error',
        message: `初期化エラー: ${errorMessage}`,
        recoverable: true,
      });
      throw err;
    }
  }

  async startRecording(): Promise<void> {
    if (this.status.state !== 'ready') {
      if (this.status.state === 'error') {
        await this.initialize();
      } else {
        throw new Error(`現在の状態では録音を開始できません: ${this.status.state}`);
      }
    }

    try {
      this.startTime = Date.now();
      this.startDurationTracking();
      if (this.options.chunkSizeSec > 0) {
        this.setupChunkedRecording();
      }
      await this.core.startRecording();
      this.updateStatus({
        state: 'recording',
        durationMs: 0,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.updateStatus({
        state: 'error',
        message: `録音開始エラー: ${errorMessage}`,
        recoverable: true,
      });
      throw err;
    }
  }

  async stopRecording(): Promise<{ blob: Blob; url: string; durationMs: number }> {
    if (this.status.state !== 'recording') {
      throw new Error('録音中ではありません');
    }

    this.stopDurationTracking();

    try {
      this.updateStatus({
        state: 'processing',
        progress: 0.1,
      });

      const blob = await this.core.stop();

      if (this.blobManager) {
        this.blobManager.addChunk(blob);
        this.updateStatus({
          state: 'processing',
          progress: 0.5,
        });

        const url = await this.blobManager.createMediaSourceUrl();
        const finalBlob = this.blobManager.getBlob();
        const durationMs = Date.now() - this.startTime;

        this.updateStatus({
          state: 'complete',
          blob: finalBlob,
          url,
          durationMs,
        });

        return { blob: finalBlob, url, durationMs };
      } else {
        const url = globalThis.URL?.createObjectURL(blob);
        const durationMs = Date.now() - this.startTime;

        this.updateStatus({
          state: 'complete',
          blob,
          url,
          durationMs,
        });

        return { blob, url, durationMs };
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.updateStatus({
        state: 'error',
        message: `録音停止エラー: ${errorMessage}`,
        recoverable: true,
      });
      throw err;
    }
  }

  dispose(): void {
    this.stopDurationTracking();
    if (this.core) {
      this.core.dispose();
    }
    if (this.blobManager) {
      this.blobManager.dispose();
      this.blobManager = null;
    }
    this.updateStatus({ state: 'idle' });
  }

  getStatus(): RecorderStatus {
    return this.status;
  }

  private setupEventHandlers(): void {
    this.core.on('speechEnd', () => {
      if (this.options.autoStop && this.status.state === 'recording') {
        this.log.info('音声終了を検出したため録音を停止します');
        this.stopRecording().catch(err => {
          this.log.error('自動停止エラー:', err);
        });
      }
    });

    this.core.on('error', (data: { message: string; recoverable: boolean }) => {
      this.updateStatus({
        state: 'error',
        message: data.message,
        recoverable: data.recoverable,
      });
    });

    this.core.on('processingProgress', (data: { progress: number }) => {
      if (this.status.state === 'processing') {
        this.updateStatus({
          state: 'processing',
          progress: data.progress,
        });
      }
    });
  }

  private setupChunkedRecording(): void {
    this.log.info('チャンク録音設定は未実装です');
  }

  private startDurationTracking(): void {
    this.stopDurationTracking();
    this.durationInterval = globalThis.setInterval(() => {
      if (this.status.state === 'recording') {
        const durationMs = Date.now() - this.startTime;
        this.updateStatus({
          state: 'recording',
          durationMs,
        });
        if (this.options.maxDurationSec > 0 && durationMs >= this.options.maxDurationSec * 1000) {
          this.log.info('最大録音時間に達したため録音を停止します');
          this.stopRecording().catch(err => {
            this.log.error('自動停止エラー:', err);
          });
        }
      }
    }, 200) as NodeJS.Timeout;
  }

  private stopDurationTracking(): void {
    if (this.durationInterval !== null) {
      globalThis.clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
  }

  private getMimeType(): string {
    const preferredTypes = ['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg', 'audio/webm'];
    if (typeof globalThis.MediaRecorder === 'undefined') {
      return 'audio/mp4';
    }
    for (const type of preferredTypes) {
      try {
        if ((globalThis.MediaRecorder as any).isTypeSupported(type)) {
          return type;
        }
      } catch (e) {}
    }
    return 'audio/mp4';
  }

  private updateStatus(newStatus: RecorderStatus): void {
    this.status = newStatus;
    this.options.statusCallback?.(newStatus);
  }
}