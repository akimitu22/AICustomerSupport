import { EventEmitter } from 'events';
import { BufferManager } from './storage';
const Capabilities = {
  detect: () => ({
    hasWorker: false, // Node.js環境ではWorkerを無効化
    isMobile: false,
    isIOS: false,
    cpuCores: 4, // 仮の値
    hasOPFS: false, // Node.js環境ではOPFS非対応
  }),
};
class FusionError extends Error {
  constructor(context, message, userMessage) {
    super(message);
    this.context = context;
    this.userMessage = userMessage;
    this.name = this.constructor.name;
  }
}
class PermissionError extends FusionError {}
class DeviceError extends FusionError {}
class WorkerError extends FusionError {}
export class FusionCore {
  constructor(options = {}) {
    this.events = new EventEmitter();
    this.state = { state: 'idle' };
    this.operationLock = null;
    this.startTime = 0;
    this.options = {
      profile: options.profile || 'auto',
      sampleRate: options.sampleRate || 44100,
      maxDurationSec: options.maxDurationSec || 0,
      vadSensitivity: options.vadSensitivity || 0.5,
      silenceTimeoutMs: options.silenceTimeoutMs || 800,
      debug: options.debug || false,
      ...options,
    };
    this.log = {
      info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
      warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
      error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
    };
    const capabilities = Capabilities.detect();
    if (this.options.profile === 'auto') {
      this.options.profile = this.selectOptimalProfile(capabilities);
    }
    this.bufferManager = new BufferManager({
      sampleRate: this.options.sampleRate,
      maxSamples: this.options.sampleRate * 300, // 5分相当
      capabilities: capabilities,
    });
    this.audioSystem = {
      initialize: async () => {},
      startRecording: async () => {},
      stopRecording: async () => {},
      getDevices: async () => [],
      selectDevice: async () => true,
      dispose: () => {},
      unlockAudioContext: async () => {},
    };
    if (capabilities.hasWorker) {
      this.initWorkers();
    }
    this.log.info('FusionCore initialized', this.options);
  }
  transition(transition) {
    if (this.state.state !== transition.from) {
      throw new Error(`Invalid transition: ${this.state.state} → ${transition.to}`);
    }
    this.state =
      transition.to === 'error'
        ? {
            state: 'error',
            error: new FusionError('transition', `to ${transition.to}`, 'System error'),
          }
        : { state: transition.to };
    this.emit(transition.to);
  }
  async withLock(operation) {
    if (this.operationLock) {
      throw new Error('Operation in progress');
    }
    const lock = (this.operationLock = operation().finally(() => {
      this.operationLock = null;
    }));
    return lock;
  }
  async initialize() {
    await this.withLock(async () => {
      if (this.state.state !== 'idle' && this.state.state !== 'error') {
        throw new Error(`Cannot initialize from ${this.state.state}`);
      }
      try {
        this.transition({ from: 'idle', to: 'initializing' });
        await this.audioSystem.initialize();
        this.transition({ from: 'initializing', to: 'ready' });
      } catch (err) {
        this.handleError('initialization', err);
        throw err;
      }
      return; // 明示的にvoidを保証
    });
  }
  async startRecording() {
    return this.withLock(async () => {
      if (this.state.state !== 'ready') {
        throw new Error(`Cannot start recording from ${this.state.state}`);
      }
      try {
        await this.unlockAudio();
        await this.initVAD();
        await this.beginCapture();
        return new Promise(resolve => {
          this.onStop = blob => resolve(blob);
          this.autoStopAfterSilence();
        });
      } catch (err) {
        this.handleError('startRecording', err);
        throw err;
      }
    });
  }
  async unlockAudio() {
    try {
      await this.audioSystem.unlockAudioContext();
    } catch (err) {
      throw new PermissionError('unlockAudio', String(err), 'Audio context unlock failed');
    }
  }
  async initVAD() {
    if (!this.vadWorker) {
      throw new WorkerError('initVAD', 'VAD worker not initialized', 'VAD worker not available');
    }
    try {
      this.vadWorker.postMessage({
        command: 'init',
        sensitivity: this.options.vadSensitivity,
        silenceTimeout: this.options.silenceTimeoutMs,
      });
    } catch (err) {
      throw new WorkerError('initVAD', String(err), 'Failed to initialize VAD');
    }
  }
  async beginCapture() {
    try {
      this.transition({ from: 'ready', to: 'starting' });
      await this.bufferManager.reset();
      await this.audioSystem.startRecording();
      this.startTime = Date.now();
      if (this.options.maxDurationSec > 0) {
        setTimeout(() => {
          if (this.state.state === 'recording') {
            this.stop().catch(e => this.handleError('maxDurationStop', e));
          }
        }, this.options.maxDurationSec * 1000);
      }
      this.transition({ from: 'starting', to: 'recording' });
    } catch (err) {
      this.handleError('beginCapture', err);
      throw err;
    }
  }
  autoStopAfterSilence() {
    if (!this.vadWorker) {
      this.log.warn('VAD worker not available for auto-stop');
      return;
    }
    const handleSpeechEnd = () => {
      this.stop()
        .then(blob => {
          if (this.onStop) {
            this.onStop(blob);
            this.onStop = undefined;
          }
        })
        .catch(err => this.handleError('autoStop', err));
    };
    this.events.once('speechEnd', handleSpeechEnd);
  }
  async stop() {
    return this.withLock(async () => {
      if (this.state.state !== 'recording') {
        throw new Error(`Cannot stop from ${this.state.state}`);
      }
      try {
        this.transition({ from: 'recording', to: 'stopping' });
        await this.audioSystem.stopRecording();
        const duration = Date.now() - this.startTime;
        this.emit('processingProgress', { stage: 'preparingData', progress: 0.2 });
        const audioData = await this.bufferManager.getAllBuffers();
        let wavBlob;
        if (!audioData || audioData.length === 0) {
          wavBlob = new Blob([], { type: 'audio/wav' });
        } else {
          this.emit('processingProgress', { stage: 'encoding', progress: 0.5 });
          wavBlob = await this.encodeToWav(audioData);
        }
        this.transition({ from: 'stopping', to: 'ready' });
        this.emit('stopped', { blob: wavBlob, duration, sampleRate: this.options.sampleRate });
        return wavBlob;
      } catch (err) {
        this.handleError('stop', err);
        throw err;
      }
    });
  }
  on(event, listener) {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }
  off(event, listener) {
    this.events.off(event, listener);
  }
  async getDevices() {
    return this.audioSystem.getDevices();
  }
  async selectDevice(deviceId) {
    return this.audioSystem.selectDevice(deviceId);
  }
  setVADSensitivity(sensitivity) {
    if (sensitivity < 0 || sensitivity > 1) {
      throw new Error('Sensitivity out of range');
    }
    this.options.vadSensitivity = sensitivity;
    if (this.vadWorker) {
      this.vadWorker.postMessage({ command: 'setSensitivity', sensitivity });
    }
  }
  dispose() {
    if (this.state.state === 'recording') {
      this.audioSystem.stopRecording().catch(() => {});
    }
    this.audioSystem.dispose();
    this.bufferManager.dispose().catch(err => this.log.error('BufferManager dispose error:', err));
    if (this.vadWorker) {
      this.vadWorker.terminate();
    }
    if (this.encoderWorker) {
      this.encoderWorker.terminate();
    }
    this.events.removeAllListeners();
    this.state = { state: 'idle' };
    this.onStop = undefined;
  }
  initWorkers() {
    try {
      // ブラウザ環境のチェック
      if (typeof window !== 'undefined' && window.Worker) {
        // ブラウザ環境: Workerを初期化（Viteでビルドする場合のパス）
        this.vadWorker = new Worker(new URL('../../workers/vad-worker.ts', import.meta.url), {
          type: 'module',
        });
        this.vadWorker.onmessage = e => this.handleVADWorkerMessage(e);
        this.vadWorker.postMessage({
          command: 'init',
          sensitivity: this.options.vadSensitivity,
          silenceTimeout: this.options.silenceTimeoutMs,
        });
        // エンコーダーワーカーを初期化
        this.encoderWorker = new Worker(
          new URL('../../workers/encoder-worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.log.info('Workers initialized successfully');
      } else {
        // Node.js環境またはWeb Worker非対応のブラウザ
        this.log.warn('Worker initialization skipped (not supported in this environment)');
      }
    } catch (error) {
      this.log.error('Failed to initialize workers:', error);
      // エラーをスローしない - フォールバック機能で対応
    }
  }
  handleVADWorkerMessage(e) {
    const d = e.data;
    if (d.type === 'vadResult') {
      this.emit('vadData', { isSpeech: d.isSpeech, energy: d.energy });
      if (d.speechStart) this.emit('speechStart');
      if (d.speechEnd) this.emit('speechEnd', { duration: d.speechDuration });
    }
  }
  handleAudioProcess(buffer) {
    if (this.state.state !== 'recording') return;
    // バッファマネージャーに音声データを保存
    this.bufferManager.addBuffer(buffer).catch(err => this.handleError('addBuffer', err));
    // VADワーカーに音声データを送信（転送で高速化）
    if (this.vadWorker) {
      try {
        // バッファをコピーして送信（元のバッファは変更せず）
        const bufferCopy = buffer.slice();
        this.vadWorker.postMessage({ type: 'process', buffer: bufferCopy }, [bufferCopy.buffer]);
      } catch (err) {
        this.log.warn('Failed to send buffer to VAD worker:', err);
      }
    }
  }
  handleDeviceChange(devices) {
    this.emit('deviceChange', { devices });
  }
  handleSystemError(context, error) {
    this.handleError(context, error);
  }
  async encodeToWav(audioData) {
    if (this.encoderWorker) {
      // ブラウザ環境: エンコーダーワーカーを使用
      return new Promise((resolve, reject) => {
        const onMessage = e => {
          if (e.data.wavBlob) {
            this.encoderWorker.removeEventListener('message', onMessage);
            resolve(e.data.wavBlob);
          } else if (e.data.progress) {
            // 進捗状況の通知
            this.emit('processingProgress', {
              stage: 'encoding',
              progress: e.data.progress,
            });
          } else if (e.data.error) {
            this.encoderWorker.removeEventListener('message', onMessage);
            reject(new Error(e.data.error));
          }
        };
        this.encoderWorker.addEventListener('message', onMessage);
        this.encoderWorker.postMessage({
          command: 'encode',
          buffer: audioData,
          sampleRate: this.options.sampleRate,
        });
      });
    } else {
      // Node.js環境またはフォールバック: メインスレッドでエンコード
      return this.encodeWavOnMainThread(audioData);
    }
  }
  encodeWavOnMainThread(audioData) {
    const dataLength = audioData.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const pcm = new Int16Array(buffer, 44, audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      const s = Math.max(-1, Math.min(1, audioData[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.writeWavHeader(view, audioData.length, this.options.sampleRate);
    return new Blob([buffer], { type: 'audio/wav' });
  }
  selectOptimalProfile(cap) {
    if (cap.isMobile) return cap.isIOS ? 'low' : 'balanced';
    return cap.cpuCores >= 4 ? 'high' : 'balanced';
  }
  handleError(context, error) {
    const fe = this.toFusionError(context, error);
    this.state = { state: 'error', error: fe };
    this.emit('error', {
      context,
      message: fe.userMessage,
      recoverable: !(fe instanceof PermissionError),
    });
  }
  toFusionError(context, error) {
    const m = error instanceof Error ? error.message : String(error);
    if (m.includes('Permission') || m.includes('NotAllowedError')) {
      return new PermissionError(context, m, 'Microphone permission required.');
    }
    if (m.includes('Device') || m.includes('NotFoundError')) {
      return new DeviceError(context, m, 'Audio device not found.');
    }
    if (m.includes('Worker')) {
      return new WorkerError(context, m, 'Background worker error.');
    }
    return new FusionError(context, m, 'An unexpected error occurred.');
  }
  emit(event, data) {
    this.events.emit(event, data);
  }
  writeWavHeader(view, samples, rate) {
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
  writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }
}
//# sourceMappingURL=FusionCore.js.map
