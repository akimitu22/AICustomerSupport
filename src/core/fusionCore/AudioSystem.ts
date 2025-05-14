/**
 * AudioSystem.ts
 * オーディオ入力と録音システムの統合管理
 */
// 修正: FusionErrorからインポート
import { DeviceError, PermissionError } from './FusionError';
import { Logger } from './Logger';
// 修正: typesから直接インポート
import { CapabilitiesResult, DeviceInfo, Profile } from './types';
// 修正: storageからBufferManagerをインポート
import { BufferManager } from './storage';
import { OPFSManager } from './OPFSManager';
import { WorkletAudioEngine } from './WorkletAudioEngine';

/**
 * AudioSystemOptions
 */
export interface AudioSystemOptions {
  capabilities: CapabilitiesResult;
  sampleRate: number;
  profile: Profile;
  onAudioProcess: (buffer: Float32Array) => void;
  onDeviceChange: (devices: DeviceInfo[]) => void;
  onError: (context: string, error: any) => void;
  debug: boolean;
}

/**
 * AudioSystem
 * マイク、エンジン、バッファを統合管理
 */
export class AudioSystem {
  private audioContext: AudioContext | null = null;
  private engine: WorkletAudioEngine | null = null;
  private bufferManager: BufferManager;
  private opfsManager: OPFSManager | null;
  private devices: DeviceInfo[] = [];
  private activeDevice: DeviceInfo | null = null;
  private options: AudioSystemOptions;
  private log: Logger;
  private deviceChangeListener: (() => void) | null = null;

  constructor(options: AudioSystemOptions) {
    this.options = options;
    this.log = new Logger(options.debug);
    this.bufferManager = new BufferManager({
      sampleRate: options.sampleRate,
      capabilities: options.capabilities,
      maxSamples: 1000000, // 必要なmaxSamplesプロパティを追加
    });
    this.opfsManager = options.capabilities.hasOPFS ? new OPFSManager() : null;
  }

  /** 初期化 */
  async initialize(): Promise<void> {
    try {
      this.log.info('AudioSystem 初期化開始');
      // Safari/iOS AudioContextアンロック
      if (this.options.capabilities.isSafari || this.options.capabilities.isIOS) {
        await this.unlockAudioContext();
      }

      // AudioContext作成
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.options.sampleRate,
        latencyHint: 'interactive',
      });

      // OPFS初期化とBufferManagerにOPFSManagerを設定
      if (this.opfsManager) {
        await this.opfsManager.initialize();
        await this.bufferManager.initialize(this.opfsManager);
      } else {
        await this.bufferManager.initialize();
      }

      // マイク権限リクエスト
      await this.requestMicrophonePermission();

      // デバイス一覧取得
      await this.refreshDevices();

      // オーディオエンジン生成
      this.engine = this.createAudioEngine();
      await this.engine.initialize(this.audioContext);

      // デバイス変更イベントリスナー
      this.setupDeviceChangeListener();
      this.log.info('AudioSystem 初期化完了');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystem.initialize エラー', error);
      if (this.options.onError) this.options.onError('initialize', error);
      throw error;
    }
  }

  /** 録音開始 */
  async startRecording(): Promise<void> {
    if (!this.engine || !this.activeDevice) {
      throw new Error('AudioSystem 初期化またはデバイス選択が完了していません');
    }
    try {
      this.engine.onAudioProcess = this.handleAudioProcess.bind(this);
      await this.engine.start(this.activeDevice);
      this.log.info('AudioSystem 録音開始');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystem.startRecording エラー', error);
      if (
        error.message.includes('Permission') ||
        error.message.includes('permission') ||
        error.message.includes('NotAllowedError')
      ) {
        throw new PermissionError('startRecording', error.message, 'マイク権限が必要です');
      }
      throw error;
    }
  }

  /** 録音停止 */
  async stopRecording(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.stop();
      // 修正: undefinedではなくnullを設定
      this.engine.onAudioProcess = null;
      this.log.info('AudioSystem 録音停止');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystem.stopRecording エラー', error);
      throw error;
    }
  }

  /** バッファリセット */
  resetBuffer(): void {
    this.bufferManager.reset();
  }

  /** 録音データ取得 */
  async getRecordedData(): Promise<Float32Array> {
    return this.bufferManager.getAllBuffers();
  }

  /** デバイス一覧取得 */
  async getDevices(): Promise<DeviceInfo[]> {
    if (this.devices.length === 0) await this.refreshDevices();
    return [...this.devices];
  }

  /** デバイス選択 */
  async selectDevice(deviceId: string): Promise<boolean> {
    if (this.devices.length === 0) await this.refreshDevices();
    const device = this.devices.find(d => d.id === deviceId);
    if (!device) return false;
    try {
      await this.testDevice(device);
      this.activeDevice = device;
      if (this.options.onDeviceChange) this.options.onDeviceChange(this.devices);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystem.selectDevice エラー', error);
      throw new DeviceError('selectDevice', error.message, 'デバイス選択に失敗しました');
    }
  }

  /** リソース解放 */
  dispose(): void {
    this.removeDeviceChangeListener();
    if (this.engine) this.engine.dispose();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.bufferManager.dispose();
    this.log.info('AudioSystem リソース解放完了');
  }

  /** デバイス一覧更新 */
  private async refreshDevices(): Promise<void> {
    const infos = await navigator.mediaDevices.enumerateDevices();
    this.devices = infos
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ id: d.deviceId, label: d.label, groupId: d.groupId }));
    if (this.devices.length === 0) throw new Error('マイクデバイスが見つかりません');
    if (!this.activeDevice || !this.devices.some(d => d.id === this.activeDevice!.id)) {
      this.activeDevice = this.devices[0];
    }
    if (this.options.onDeviceChange) this.options.onDeviceChange(this.devices);
  }

  /** デバイステスト */
  private async testDevice(device: DeviceInfo): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.id } },
    });
    stream.getTracks().forEach(t => t.stop());
  }

  /** Safari/iOS 用 AudioContext アンロック */
  private async unlockAudioContext(): Promise<void> {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const buffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    await ctx.close();
  }

  /** マイク権限取得 */
  private async requestMicrophonePermission(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  }

  /** エンジン生成 */
  private createAudioEngine(): WorkletAudioEngine {
    const cap = this.options.capabilities;
    try {
      if (cap.hasAudioWorklet) return new WorkletAudioEngine();
    } catch (error) {
      // 修正: 空のブロックからエラーログ出力に変更
      this.log.error('WorkletAudioEngine生成エラー', error);
    }
    throw new Error('AudioWorkletがサポートされていない環境です');
  }

  /** デバイス変更リスナー設定 */
  private setupDeviceChangeListener(): void {
    if (!navigator.mediaDevices.addEventListener) return;
    this.deviceChangeListener = () => this.refreshDevices().catch(e => this.log.error(e));
    navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeListener);
  }

  /** リスナー解除 */
  private removeDeviceChangeListener(): void {
    if (this.deviceChangeListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeListener);
    }
  }

  /** オーディオ処理ハンドラ */
  private handleAudioProcess(buffer: Float32Array): void {
    this.bufferManager.addBuffer(buffer).catch(e => this.log.error(e));
    if (this.options.onAudioProcess) this.options.onAudioProcess(buffer);
  }
}
