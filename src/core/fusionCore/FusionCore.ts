/**
 * FusionCore.ts
 * 音声入力・処理の中核機能を提供するコアクラス
 */
import { EventEmitter } from 'events';

// 仮の型定義（依存モジュールが見つからないため、必要な型を直接定義）
interface CapabilitiesResult {
  hasMediaRecorder: boolean;
  isIOS: boolean;
  isMobile: boolean;
  cpuCores: number;
  hasAudioWorklet: boolean;
  hasScriptProcessor: boolean;
  hasWorker: boolean;
  hasOPFS: boolean;
  isSafari: boolean;
}

interface DeviceInfo {
  deviceId: string;
  label: string;
}

interface CoreOptions {
  profile?: string;
  sampleRate?: number;
  maxDurationSec?: number;
  vadSensitivity?: number;
  silenceTimeoutMs?: number;
  debug?: boolean;
}

type Profile = 'low' | 'balanced' | 'high' | 'auto';

type CoreEvent =
  | 'initializing'
  | 'ready'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'vadData'
  | 'speechStart'
  | 'speechEnd'
  | 'deviceChange'
  | 'error'
  | 'processingProgress';

interface CoreState {
  state:
    | 'idle'
    | 'initializing'
    | 'ready'
    | 'starting'
    | 'recording'
    | 'stopping'
    | 'error';
  error?: FusionError;
}

interface StateTransition {
  from: CoreState['state'];
  to: CoreState['state'];
}

interface AudioSystem {
  initialize: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  dispose: () => void;
  getDevices: () => Promise<DeviceInfo[]>;
  selectDevice: (deviceId: string) => Promise<boolean>;
  unlockAudioContext: () => Promise<void>;
  onAudioProcess?: (buffer: Float32Array) => void;
  onDeviceChange?: (devices: DeviceInfo[]) => void;
  onError?: (context: string, error: any) => void;
  useEnhancedEngine?: (enable: boolean) => void;
}

interface BufferManager {
  addBuffer: (buffer: Float32Array) => Promise<void>;
  getAllBuffers: () => Promise<Float32Array>;
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
}

class FusionError extends Error {
  constructor(
    public context: string,
    public message: string,
    public userMessage: string
  ) {
    super(message);
  }
}

class PermissionError extends FusionError {}
class DeviceError extends FusionError {}
class WorkerError extends FusionError {}

class Logger {
  private debugEnabled: boolean;

  constructor(debug: boolean = false) {
    this.debugEnabled = debug;
  }

  info(...args: any[]): void {
    if (this.debugEnabled) {
      console.info('[FusionCore][INFO]', ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.debugEnabled) {
      console.warn('[FusionCore][WARN]', ...args);
    }
  }

  error(...args: any[]): void {
    console.error('[FusionCore][ERROR]', ...args);
  }

  debug(...args: any[]): void {
    if (this.debugEnabled) {
      console.debug('[FusionCore][DEBUG]', ...args);
    }
  }
}

const Capabilities = {
  detect: (): CapabilitiesResult => ({
    hasMediaRecorder: true,
    isIOS: false,
    isMobile: false,
    cpuCores: 4,
    hasAudioWorklet: true,
    hasScriptProcessor: true,
    hasWorker: true,
    hasOPFS: true,
    isSafari: false,
  }),
};

/**
 * FusionCore - 音声入力・処理の中核クラス
 */
export class FusionCore {
  private audioSystem: AudioSystem;
  private bufferManager: BufferManager;
  private options: Required<CoreOptions>;
  private vadWorker?: any;
  private encoderWorker?: any;
  private events = new EventEmitter();
  private state: CoreState = { state: 'idle' };
  private operationLock: Promise<unknown> | null = null;
  private startTime = 0;
  private log: Logger;
  private onStop?: (blob: Blob) => void;
  private isVadInitialized = false;
  private capabilities: CapabilitiesResult;

  constructor(options: CoreOptions = {}) {
    this.options = {
      profile: options.profile || 'auto',
      sampleRate: options.sampleRate || 44100,
      maxDurationSec: options.maxDurationSec || 0,
      vadSensitivity: options.vadSensitivity || 0.5,
      silenceTimeoutMs: options.silenceTimeoutMs || 800,
      debug: options.debug || false,
    };

    this.log = new Logger(this.options.debug);

    // 環境機能の検出
    this.capabilities = Capabilities.detect();
    this.log.info('検出された環境機能:', this.capabilities);

    // プロファイルの自動選択
    if (this.options.profile === 'auto') {
      this.options.profile = this.selectOptimalProfile(this.capabilities);
      this.log.info(`自動選択されたプロファイル: ${this.options.profile}`);
    }

    // バッファマネージャの初期化（仮実装）
    this.bufferManager = {
      addBuffer: async (buffer: Float32Array) => {},
      getAllBuffers: async () => new Float32Array(0),
      reset: async () => {},
      dispose: async () => {},
    };

    // オーディオシステムの初期化（仮実装）
    this.audioSystem = {
      initialize: async () => {},
      startRecording: async () => {},
      stopRecording: async () => {},
      dispose: () => {},
      getDevices: async () => [],
      selectDevice: async () => true,
      unlockAudioContext: async () => {},
      useEnhancedEngine: (enable: boolean) => {
        this.log.info(`useEnhancedEngine called with: ${enable}`);
      },
    };

    // オーディオシステムのコールバック設定
    this.audioSystem.onAudioProcess = this.handleAudioProcess.bind(this);
    this.audioSystem.onDeviceChange = this.handleDeviceChange.bind(this);
    this.audioSystem.onError = this.handleSystemError.bind(this);

    if (this.capabilities.hasWorker) {
      this.initWorkers();
    }

    this.log.info('FusionCore初期化完了', this.options);
  }

  public getRecordingCapabilities(): CapabilitiesResult & {
    hasBasicRecording: boolean;
    hasStableRecording: boolean;
    recommendedMaxDuration: number;
    hasLongRecording: boolean;
  } {
    return {
      ...this.capabilities,
      hasBasicRecording: this.capabilities.hasMediaRecorder || this.capabilities.hasScriptProcessor,
      hasStableRecording: this.capabilities.hasMediaRecorder && this.capabilities.cpuCores >= 2,
      recommendedMaxDuration: this.capabilities.isIOS ? 300 : 1800,
      hasLongRecording: !this.capabilities.isIOS && this.capabilities.cpuCores >= 4,
    };
  }

  private transition(transition: StateTransition): void {
    if (this.state.state !== transition.from) {
      throw new Error(`無効な状態遷移: ${this.state.state} → ${transition.to}`);
    }

    if (transition.to === 'error') {
      this.state = {
        state: 'error',
        error: new FusionError('transition', `状態遷移エラー: ${transition.to}`, 'システムエラーが発生しました'),
      };
    } else {
      this.state = { state: transition.to };
    }

    this.emit(transition.to as CoreEvent);
  }

  private async withLock<T>(operation: () => Promise<T>, operationName?: string): Promise<T> {
    if (this.operationLock) {
      this.log.warn(`操作 '${operationName || '不明'}' は別の操作が実行中のため開始できません`);
      throw new Error('別の操作が実行中です');
    }

    let result: T;
    try {
      const lock = operation();
      this.operationLock = lock;
      result = await lock;
    } catch (error) {
      this.log.error(`操作でエラー発生: '${operationName || '不明'}'`, error);
      throw error;
    } finally {
      this.operationLock = null;
    }

    return result;
  }

  async initialize(): Promise<void> {
    return this.withLock<void>(async () => {
      if (this.state.state !== 'idle' && this.state.state !== 'error') {
        throw new Error(`現在の状態 ${this.state.state} から初期化できません`);
      }

      try {
        this.transition({ from: 'idle', to: 'initializing' });
        await this.audioSystem.initialize();
        this.transition({ from: 'initializing', to: 'ready' });
        this.log.info('FusionCore初期化が完了し、使用可能な状態になりました');
      } catch (err: unknown) {
        this.handleError('initialization', err);
        throw err;
      }
    }, 'initialize');
  }

  async startRecording(): Promise<Blob> {
    return this.withLock<Blob>(async () => {
      if (this.state.state !== 'ready') {
        throw new Error(`現在の状態 ${this.state.state} から録音を開始できません`);
      }

      try {
        await this.unlockAudio();
        await this.initVAD();
        this.transition({ from: 'ready', to: 'starting' });
        await this.beginCapture();
        this.operationLock = null;

        return new Promise(resolve => {
          this.onStop = blob => resolve(blob);
          this.autoStopAfterSilence();
        });
      } catch (err: unknown) {
        this.handleError('startRecording', err);
        throw err;
      }
    }, 'startRecording');
  }

  private async unlockAudio(): Promise<void> {
    try {
      this.log.info('AudioContextのアンロック試行...');
      await this.audioSystem.unlockAudioContext();
      this.log.info('AudioContextのアンロックに成功しました');
    } catch (err: unknown) {
      this.log.error('AudioContextのアンロックに失敗:', err);
      throw new PermissionError('unlockAudio', String(err), 'オーディオシステムのアンロックに失敗しました');
    }
  }

  private async initVAD(): Promise<void> {
    if (!this.vadWorker) {
      this.log.info('VADワーカーが初期化されていないためスキップします');
      return;
    }

    try {
      this.log.info('VADを初期化、感度:', this.options.vadSensitivity);
      this.vadWorker.postMessage({
        command: 'init',
        sensitivity: this.options.vadSensitivity,
        silenceTimeout: this.options.silenceTimeoutMs,
      });
      this.isVadInitialized = true;
      this.log.info('VADの初期化が成功しました');
    } catch (err: unknown) {
      this.log.error('VAD初期化エラー:', err);
      throw new WorkerError('initVAD', String(err), 'VADの初期化に失敗しました');
    }
  }

  private async beginCapture(): Promise<void> {
    try {
      await this.bufferManager.reset();
      this.log.info('バッファのリセット完了');
      await this.audioSystem.startRecording();
      this.log.info('録音開始');
      this.startTime = Date.now();

      if (this.options.maxDurationSec > 0) {
        this.log.info(`最大録音時間を設定: ${this.options.maxDurationSec}秒`);
        setTimeout(() => {
          if (this.state.state === 'recording') {
            this.log.info('最大録音時間に到達したため停止します...');
            this.stop().catch(e => this.handleError('maxDurationStop', e));
          }
        }, this.options.maxDurationSec * 1000);
      }

      this.transition({ from: 'starting', to: 'recording' });
    } catch (err: unknown) {
      this.handleError('beginCapture', err);
      throw err;
    }
  }

  private autoStopAfterSilence(): void {
    if (!this.vadWorker || !this.isVadInitialized) {
      this.log.warn('自動停止のためのVADが利用できません');
      return;
    }

    this.log.info('無音検出後の自動停止を設定');
    const handleSpeechEnd = () => {
      this.log.info('音声終了を検出、録音を自動停止します');
      this.stop()
        .then(blob => {
          this.log.info(`録音自動停止、Blobサイズ: ${blob.size} バイト`);
          if (this.onStop) {
            this.onStop(blob);
            this.onStop = undefined;
          }
        })
        .catch(err => {
          this.log.error('自動停止に失敗:', err);
          this.handleError('autoStop', err);
        });
    };

    this.events.once('speechEnd', handleSpeechEnd);
    this.log.info('自動停止ハンドラを登録しました');
  }

  async stop(): Promise<Blob> {
    if (this.state.state !== 'recording') {
      this.log.warn(`状態 ${this.state.state} から停止できません`);
      throw new Error(`状態 ${this.state.state} から停止できません`);
    }

    try {
      this.log.info('録音を停止しています...');
      this.transition({ from: 'recording', to: 'stopping' });

      await this.audioSystem.stopRecording();
      const duration = Date.now() - this.startTime;
      this.log.info(`録音停止、継続時間: ${duration}ms`);

      this.emit('processingProgress', { stage: 'preparingData', progress: 0.2 });
      const audioData = await this.bufferManager.getAllBuffers();
      this.log.info(`取得した音声データ: ${audioData ? audioData.length : 0} サンプル`);

      let wavBlob: Blob;
      if (!audioData || audioData.length === 0) {
        this.log.warn('取得した音声データがありません');
        wavBlob = new Blob([], { type: 'audio/wav' });
      } else {
        this.emit('processingProgress', { stage: 'encoding', progress: 0.5 });
        wavBlob = await this.encodeToWav(audioData);
        this.log.info(`WAVエンコード完了、Blobサイズ: ${wavBlob.size} バイト`);
      }

      this.transition({ from: 'stopping', to: 'ready' });
      this.emit('stopped', { blob: wavBlob, duration, sampleRate: this.options.sampleRate });
      return wavBlob;
    } catch (err: unknown) {
      this.handleError('stop', err);
      throw err;
    }
  }

  on(event: CoreEvent, listener: (...args: any[]) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  off(event: CoreEvent, listener: (...args: any[]) => void): void {
    this.events.off(event, listener);
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return this.audioSystem.getDevices();
  }

  async selectDevice(deviceId: string): Promise<boolean> {
    return this.audioSystem.selectDevice(deviceId);
  }

  setVADSensitivity(sensitivity: number): void {
    if (sensitivity < 0 || sensitivity > 1) {
      throw new Error('感度は0～1の範囲で指定してください');
    }
    this.options.vadSensitivity = sensitivity;
    if (this.vadWorker && this.isVadInitialized) {
      this.vadWorker.postMessage({ command: 'setSensitivity', sensitivity });
    }
  }

  dispose(): void {
    this.log.info('FusionCoreリソースを解放しています');

    if (this.state.state === 'recording') {
      this.log.info('破棄前に録音を停止しています');
      this.audioSystem.stopRecording().catch(err => {
        this.log.error('破棄中の録音停止エラー:', err);
      });
    }

    this.audioSystem.dispose();
    this.log.info('AudioSystemを解放しました');

    this.bufferManager.dispose().catch(err => {
      this.log.error('BufferManager解放エラー:', err);
    });

    if (this.vadWorker) {
      this.vadWorker.terminate();
      this.log.info('VADワーカーを終了しました');
    }

    if (this.encoderWorker) {
      this.encoderWorker.terminate();
      this.log.info('エンコーダーワーカーを終了しました');
    }

    this.events.removeAllListeners();
    this.state = { state: 'idle' };
    this.onStop = undefined;
    this.log.info('FusionCoreのリソースを完全に解放しました');
  }

  private initWorkers(): void {
    try {
      if (typeof globalThis !== 'undefined' && (globalThis as any).Worker) {
        this.log.info('Webワーカーを初期化しています...');

        try {
          this.vadWorker = new (globalThis as any).Worker(new URL('/fusionCore/workers/vad-worker.js', (globalThis as any).location?.origin));
          this.vadWorker.onmessage = (e: MessageEvent) => this.handleVADWorkerMessage(e);
          this.vadWorker.onerror = (e: any) => {
            this.log.error('VADワーカーエラー:', e.message);
          };
          this.vadWorker.postMessage({
            command: 'init',
            sensitivity: this.options.vadSensitivity,
            silenceTimeout: this.options.silenceTimeoutMs,
          });
          this.log.info('VADワーカーの初期化に成功しました');
        } catch (error) {
          this.log.error('VADワーカーの初期化に失敗:', error);
        }

        try {
          this.encoderWorker = new (globalThis as any).Worker(new URL('/fusionCore/workers/encoder-worker.js', (globalThis as any).location?.origin));
          this.encoderWorker.onerror = (e: any) => {
            this.log.error('エンコーダーワーカーエラー:', e.message);
          };
          this.log.info('エンコーダーワーカーの初期化に成功しました');
        } catch (error) {
          this.log.error('エンコーダーワーカーの初期化に失敗:', error);
        }
      } else {
        this.log.warn('ワーカー初期化をスキップ (この環境ではサポートされていません)');
      }
    } catch (error) {
      this.log.error('ワーカーの初期化に失敗:', error);
    }
  }

  private handleVADWorkerMessage(e: MessageEvent): void {
    const d = e.data;
    if (d.type === 'vadResult') {
      if (this.options.debug) {
        this.log.info(`VAD結果: 音声=${d.isSpeech}, エネルギー=${d.energy?.toFixed(4)}`);
      }
      this.emit('vadData', { isSpeech: d.isSpeech, energy: d.energy });
      if (d.speechStart) {
        this.log.info('音声開始を検出');
        this.emit('speechStart');
      }
      if (d.speechEnd) {
        this.log.info(`音声終了を検出、継続時間: ${d.speechDuration}秒`);
        this.emit('speechEnd', { duration: d.speechDuration });
      }
    } else if (d.type === 'ping') {
      this.log.info('VADワーカーからpingを受信:', d);
    } else {
      this.log.info('VADワーカーからメッセージを受信:', d);
    }
  }

  private handleAudioProcess(buffer: Float32Array): void {
    if (this.state.state !== 'recording') {
      return;
    }

    if (this.options.debug && Math.random() < 0.01) {
      const energy = this.calculateEnergy(buffer);
      this.log.info(`オーディオ処理: ${buffer.length} サンプル, エネルギー: ${energy.toFixed(4)}`);
    }

    this.bufferManager.addBuffer(buffer).catch(err => {
      this.log.error('バッファ追加エラー:', err);
      this.handleError('addBuffer', err);
    });

    if (this.vadWorker && this.isVadInitialized) {
      try {
        const bufferCopy = buffer.slice();
        this.vadWorker.postMessage({ type: 'process', buffer: bufferCopy }, [bufferCopy.buffer]);
      } catch (err) {
        this.log.warn('VADワーカーへのバッファ送信エラー:', err);
      }
    }
  }

  private calculateEnergy(buffer: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }

  private handleDeviceChange(devices: DeviceInfo[]): void {
    this.emit('deviceChange', { devices });
  }

  private handleSystemError(context: string, error: any): void {
    this.handleError(context, error);
  }

  private async encodeToWav(audioData: Float32Array): Promise<Blob> {
    if (this.encoderWorker) {
      this.log.info('エンコーダーワーカーを使用してWAVエンコード');
      return new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent) => {
          if (e.data.wavBlob) {
            this.encoderWorker!.removeEventListener('message', onMessage);
            this.log.info(`エンコード完了、Blobサイズ: ${e.data.wavBlob.size} バイト`);
            resolve(e.data.wavBlob);
          } else if (e.data.progress) {
            this.emit('processingProgress', { stage: 'encoding', progress: e.data.progress });
          } else if (e.data.error) {
            this.encoderWorker!.removeEventListener('message', onMessage);
            this.log.error('エンコーダーワーカーエラー:', e.data.error);
            reject(new Error(e.data.error));
          }
        };

        this.encoderWorker!.addEventListener('message', onMessage);

        this.log.info(`${audioData.length} サンプルをエンコーダーワーカーに送信`);
        this.encoderWorker!.postMessage({
          command: 'encode',
          buffer: audioData,
          sampleRate: this.options.sampleRate,
        });
      });
    } else {
      this.log.info('メインスレッドでWAVエンコード (フォールバック)');
      return this.encodeWavOnMainThread(audioData);
    }
  }

  private encodeWavOnMainThread(audioData: Float32Array): Blob {
    this.log.info('メインスレッドでWAVエンコード開始');
    const dataLength = audioData.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const pcm = new Int16Array(buffer, 44, audioData.length);

    for (let i = 0; i < audioData.length; i++) {
      const s = Math.max(-1, Math.min(1, audioData[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.writeWavHeader(view, audioData.length, this.options.sampleRate);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    this.log.info(`メインスレッドエンコード完了、Blobサイズ: ${blob.size} バイト`);
    return blob;
  }

  private selectOptimalProfile(cap: CapabilitiesResult): Profile {
    if (cap.isMobile) {
      return cap.isIOS ? 'low' : 'balanced';
    }
    return cap.cpuCores >= 4 ? 'high' : 'balanced';
  }

  private handleError(context: string, error: unknown): void {
    const fe = this.toFusionError(context, error);
    this.state = { state: 'error', error: fe };
    this.emit('error', {
      context,
      message: fe.userMessage,
      recoverable: !(fe instanceof PermissionError),
      error: fe,
    });
  }

  private toFusionError(context: string, error: unknown): FusionError {
    if (error instanceof FusionError) {
      return error;
    }

    const m = error instanceof Error ? error.message : String(error);
    if (m.includes('Permission') || m.includes('NotAllowedError')) {
      return new PermissionError(context, m, 'マイク使用権限が必要です');
    }
    if (m.includes('Device') || m.includes('NotFoundError')) {
      return new DeviceError(context, m, 'オーディオデバイスが見つかりません');
    }
    if (m.includes('Worker')) {
      return new WorkerError(context, m, 'バックグラウンドワーカーでエラーが発生しました');
    }
    return new FusionError(context, m, '予期しないエラーが発生しました');
  }

  private emit(event: CoreEvent, data?: any): void {
    this.events.emit(event, data);
  }

  private writeWavHeader(view: DataView, samples: number, rate: number): void {
    const len = samples * 2;
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + len, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, len, true);
  }

  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}