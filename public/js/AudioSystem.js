/**
 * AudioSystem.ts
 * オーディオ入力と録音システムの統合管理
 */
// 修正: FusionErrorからインポート
import { DeviceError, PermissionError } from './FusionError';
import { Logger } from './Logger';
// 修正: storageからBufferManagerをインポート
import { BufferManager } from './storage';
import { OPFSManager } from './OPFSManager';
import { WorkletAudioEngine } from './WorkletAudioEngine';
import { ScriptProcessorEngine } from './ScriptProcessorEngine';
import { MediaRecorderEngine } from './MediaRecorderEngine';
/**
 * AudioSystem
 * マイク、エンジン、バッファを統合管理
 */
export class AudioSystem {
  constructor(options) {
    this.audioContext = null;
    this.engine = null;
    this.devices = [];
    this.activeDevice = null;
    this.deviceChangeListener = null;
    this.options = options;
    this.log = new Logger(options.debug);
    this.bufferManager = new BufferManager({
      sampleRate: options.sampleRate,
      capabilities: options.capabilities,
      debug: options.debug,
    });
    this.opfsManager = options.capabilities.hasOPFS ? new OPFSManager() : null;
  }
  /** 初期化 */
  async initialize() {
    try {
      this.log.info('AudioSystem 初期化開始');
      // Safari/iOS AudioContextアンロック
      if (this.options.capabilities.isSafari || this.options.capabilities.isIOS) {
        await this.unlockAudioContext();
      }
      // AudioContext作成
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: this.options.sampleRate,
        latencyHint: 'interactive',
      });
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
  async startRecording() {
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
  async stopRecording() {
    if (!this.engine) return;
    try {
      await this.engine.stop();
      this.engine.onAudioProcess = undefined;
      this.log.info('AudioSystem 録音停止');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystem.stopRecording エラー', error);
      throw error;
    }
  }
  /** バッファリセット */
  resetBuffer() {
    this.bufferManager.reset();
  }
  /** 録音データ取得 */
  async getRecordedData() {
    return this.bufferManager.getAllBuffers();
  }
  /** デバイス一覧取得 */
  async getDevices() {
    if (this.devices.length === 0) await this.refreshDevices();
    return [...this.devices];
  }
  /** デバイス選択 */
  async selectDevice(deviceId) {
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
  dispose() {
    this.removeDeviceChangeListener();
    if (this.engine) this.engine.dispose();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    this.bufferManager.dispose();
    this.log.info('AudioSystem リソース解放完了');
  }
  /** デバイス一覧更新 */
  async refreshDevices() {
    const infos = await navigator.mediaDevices.enumerateDevices();
    this.devices = infos
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ id: d.deviceId, label: d.label, groupId: d.groupId }));
    if (this.devices.length === 0) throw new Error('マイクデバイスが見つかりません');
    if (!this.activeDevice || !this.devices.some(d => d.id === this.activeDevice.id)) {
      this.activeDevice = this.devices[0];
    }
    if (this.options.onDeviceChange) this.options.onDeviceChange(this.devices);
  }
  /** デバイステスト */
  async testDevice(device) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: device.id } },
    });
    stream.getTracks().forEach(t => t.stop());
  }
  /** Safari/iOS 用 AudioContext アンロック */
  async unlockAudioContext() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    await ctx.close();
  }
  /** マイク権限取得 */
  async requestMicrophonePermission() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  }
  /** エンジン生成 */
  createAudioEngine() {
    const cap = this.options.capabilities;
    try {
      if (cap.hasAudioWorklet) return new WorkletAudioEngine();
    } catch {}
    if (cap.hasScriptProcessor) return new ScriptProcessorEngine();
    return new MediaRecorderEngine();
  }
  /** デバイス変更リスナー設定 */
  setupDeviceChangeListener() {
    if (!navigator.mediaDevices.addEventListener) return;
    this.deviceChangeListener = () => this.refreshDevices().catch(e => this.log.error(e));
    navigator.mediaDevices.addEventListener('devicechange', this.deviceChangeListener);
  }
  /** リスナー解除 */
  removeDeviceChangeListener() {
    if (this.deviceChangeListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.deviceChangeListener);
    }
  }
  /** オーディオ処理ハンドラ */
  handleAudioProcess(buffer) {
    this.bufferManager.addBuffer(buffer).catch(e => this.log.error(e));
    if (this.options.onAudioProcess) this.options.onAudioProcess(buffer);
  }
}
//# sourceMappingURL=AudioSystem.js.map
