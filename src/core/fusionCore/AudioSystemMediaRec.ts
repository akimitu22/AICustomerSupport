/**
 * AudioSystemMediaRec.ts
 * iOS対応のオーディオシステム実装（MediaRecorder使用）
 */
import { Logger } from './Logger';
import { DeviceInfo, AudioSystem, CapabilitiesResult } from './types';
import { Capabilities } from './types';
import { PermissionError, DeviceError } from './FusionError';
import { EnhancedMediaRecorderEngine } from './EnhancedMediaRecorderEngine';

/**
 * MediaRecorderを使用したオーディオシステム実装
 * iOSなどのAudioWorklet非対応環境向け
 */
export class AudioSystemMediaRec implements AudioSystem {
  private ctx!: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private audioWorklet?: AudioWorkletNode;
  private scriptProcessor?: ScriptProcessorNode; // フォールバック用
  private isRecording: boolean = false;
  private useWorklet: boolean = false;
  private devices: DeviceInfo[] = [];
  private activeDevice: DeviceInfo | null = null;
  private log: Logger;
  private capabilities: CapabilitiesResult;
  private useEnhancedRecorder: boolean = false;
  private enhancedEngine?: EnhancedMediaRecorderEngine;
  private visibilityChangeHandler: (() => void) | null = null;
  private iosVersion: number = 0;
  private debug: boolean; // デバッグモードフラグを保持

  // AudioSystemインターフェース実装
  onAudioProcess?: (buffer: Float32Array) => void;
  onDeviceChange?: (devices: DeviceInfo[]) => void;
  onError?: (context: string, error: any) => void;

  /**
   * コンストラクタ
   * @param debug デバッグモード有効化フラグ
   */
  constructor(debug: boolean = false) {
    this.debug = debug; // デバッグフラグを保持
    this.log = new Logger(debug);
    this.capabilities = Capabilities.detect();
    
    // iOS環境の検出
    if (this.capabilities.isIOS) {
      this.iosVersion = this.detectIOSVersion();
      this.log.info(`iOS環境を検出: バージョン ${this.iosVersion}`);
    }
    
    // 可視性変更ハンドラのセットアップ
    this.setupVisibilityChangeHandler();
  }

  /**
   * iOSバージョンの検出
   */
  private detectIOSVersion(): number {
    const match = navigator.userAgent.match(/OS (\d+)_/);
    return match ? parseInt(match[1], 10) : 0;
  }

  /**
   * 可視性変更監視ハンドラ
   */
  private setupVisibilityChangeHandler(): void {
    if (typeof document === 'undefined') return;
    
    this.visibilityChangeHandler = () => {
      if (document.visibilityState === 'visible') {
        this.log.info('ページがフォアグラウンドに戻りました');
        
        // AudioContext再開
        this.resumeAudioContext();
      }
    };
    
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  /**
   * AudioContextの再開
   */
  private resumeAudioContext(): void {
    if (this.ctx?.state === 'suspended') {
      this.log.info('AudioContextを再開します');
      this.ctx.resume().catch(err => {
        this.log.warn('AudioContext再開失敗:', err);
        this.notifyError('resumeAudioContext', err);
      });
    }
  }

  /**
   * エラー通知ユーティリティ
   */
  private notifyError(context: string, error: any): void {
    this.log.error(`エラー発生 (${context}):`, error);
    if (this.onError) {
      this.onError(context, error);
    }
  }

  /**
   * 強化されたMediaRecorderエンジンを使用するかどうかを設定
   * @param enable 有効化フラグ
   */
  useEnhancedEngine(enable: boolean): void {
    this.useEnhancedRecorder = enable;
    this.log.info(`EnhancedRecorder enabled: ${enable}`);
  }

  /**
   * オーディオシステムの初期化
   */
  async initialize(): Promise<void> {
    this.log.info('AudioSystemMediaRec: 初期化開始');

    try {
      // デバイス一覧の取得
      await this.refreshDevices();

      // ① AudioContext を作成
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

      // サスペンドされていれば再開
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
        this.log.info('AudioSystemMediaRec: AudioContext resumed');
      }

      // ③ AudioWorklet をロード（サポートされている場合）
      try {
        if ('audioWorklet' in this.ctx) {
          await this.ctx.audioWorklet.addModule('/fusionCore/worklets/audio-processor.js');
          this.useWorklet = true;
          this.log.info('AudioSystemMediaRec: AudioWorklet loaded successfully');
        } else {
          this.log.info(
            'AudioSystemMediaRec: AudioWorklet not supported, falling back to ScriptProcessor'
          );
          this.useWorklet = false;
        }
      } catch (error) {
        this.log.warn(
          'AudioSystemMediaRec: Failed to load AudioWorklet, falling back to ScriptProcessor',
          error
        );
        this.useWorklet = false;
      }

      // EnhancedMediaRecorderの事前初期化
      if (this.useEnhancedRecorder && this.capabilities.isIOS) {
        this.enhancedEngine = new EnhancedMediaRecorderEngine(this.debug); // debugEnabled の代わりに this.debug を使用
        await this.enhancedEngine.initialize(this.ctx);
      }

      this.log.info('AudioSystemMediaRec: 初期化完了');
    } catch (err) {
      this.log.error('AudioSystemMediaRec: 初期化エラー', err);
      
      // リソースの解放
      await this.releaseResources();
      
      // エラーコールバックがあれば呼び出し
      this.notifyError('initialize', err);
      
      throw err;
    }
  }

  /**
   * 利用可能なオーディオデバイス一覧の取得
   * @returns デバイス情報の配列
   */
  async getDevices(): Promise<DeviceInfo[]> {
    if (this.devices.length === 0) {
      await this.refreshDevices();
    }
    return [...this.devices];
  }

  /**
   * オーディオデバイスの選択
   * @param deviceId デバイスID
   * @returns 成功した場合はtrue
   */
  async selectDevice(deviceId: string): Promise<boolean> {
    if (this.devices.length === 0) {
      await this.refreshDevices();
    }

    const device = this.devices.find(d => d.id === deviceId);
    if (!device) {
      return false;
    }

    try {
      // デバイスのテスト (権限確認)
      await this.testDevice(device);
      this.activeDevice = device;

      // デバイス変更通知
      if (this.onDeviceChange) {
        this.onDeviceChange(this.devices);
      }

      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.log.error('AudioSystemMediaRec.selectDevice エラー', error);
      
      this.notifyError('selectDevice', error);
      throw new DeviceError('selectDevice', error.message, 'デバイス選択に失敗しました');
    }
  }

  /**
   * AudioContextのアンロック（iOS対応）
   */
  async unlockAudioContext(): Promise<void> {
    this.log.info('AudioSystemMediaRec: AudioContext解除試行');

    try {
      if (!this.ctx) {
        // AudioContextがまだ初期化されていない場合は作成
        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      }

      if (this.ctx.state === 'suspended') {
        // iOS Safariでは一時的なバッファ再生が必要
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(this.ctx.destination);
        source.start(0);

        // iOS 15未満では追加の無音再生が効果的な場合がある
        if (this.capabilities.isIOS && this.iosVersion < 15) {
          const silenceBuffer = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.1, this.ctx.sampleRate);
          const silenceSource = this.ctx.createBufferSource();
          silenceSource.buffer = silenceBuffer;
          silenceSource.connect(this.ctx.destination);
          silenceSource.start();
        }

        await this.ctx.resume();
        this.log.info('AudioSystemMediaRec: AudioContext解除成功');
      }
    } catch (error) {
      this.log.error('AudioSystemMediaRec: AudioContext解除失敗', error);
      this.notifyError('unlockAudioContext', error);
      throw error;
    }
  }

  /**
   * 録音開始
   */
  async startRecording(): Promise<void> {
    this.log.info('AudioSystemMediaRec: 録音開始');

    if (!this.activeDevice) {
      try {
        const devices = await this.getDevices();
        if (devices.length > 0) {
          this.activeDevice = devices[0];
        } else {
          throw new PermissionError(
            'startRecording',
            'No active device selected',
            'マイクデバイスが選択されていません'
          );
        }
      } catch (err) {
        this.notifyError('startRecording', err);
        throw err;
      }
    }

    try {
      // マイクストリームの取得
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: { exact: this.activeDevice.id },
          echoCancellation: true,
          noiseSuppression: true,
        },
      };
      
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);

      // マイクの入力ソースを作成
      this.source = this.ctx.createMediaStreamSource(this.stream);

      // AudioContextが停止していないか確認
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }

      // オーディオ処理の初期化
      if (this.useEnhancedRecorder && this.capabilities.isIOS) {
        // 強化されたMediaRecorderエンジンを使用
        if (!this.enhancedEngine) {
          this.enhancedEngine = new EnhancedMediaRecorderEngine(this.debug); // debugEnabled の代わりに this.debug を使用
          await this.enhancedEngine.initialize(this.ctx);
        }
        
        // コールバックの設定
        this.enhancedEngine.onAudioProcess = buffer => {
          if (this.onAudioProcess) {
            this.onAudioProcess(buffer);
          }
        };
        
        this.enhancedEngine.onError = (context, error) => {
          if (this.onError) {
            this.onError(`enhancedEngine:${context}`, error);
          }
        };
        
        // 録音開始
        await this.enhancedEngine.start(this.activeDevice);
      } else if (this.useWorklet) {
        this.initAudioWorklet();
      } else {
        this.initScriptProcessor();
      }

      this.isRecording = true;
    } catch (err) {
      this.log.error('AudioSystemMediaRec: 録音開始エラー', err);
      
      // リソースの解放
      await this.releaseResources();
      
      // エラー変換と通知
      const error = err instanceof Error ? err : new Error(String(err));
      
      if (
        error.message.includes('Permission') ||
        error.message.includes('permission') ||
        error.message.includes('NotAllowedError')
      ) {
        const permError = new PermissionError('startRecording', error.message, 'マイク権限が必要です');
        this.notifyError('startRecording', permError);
        throw permError;
      }
      
      this.notifyError('startRecording', error);
      throw error;
    }
  }

  /**
   * 録音停止
   */
  async stopRecording(): Promise<void> {
    this.log.info('AudioSystemMediaRec: 録音停止');
    this.isRecording = false;

    try {
      if (this.enhancedEngine) {
        // 強化されたエンジンを使用していた場合
        await this.enhancedEngine.stop();
      } else if (this.useWorklet && this.audioWorklet) {
        try {
          this.audioWorklet.port.postMessage({ command: 'stop' });
        } catch (e) {
          this.log.warn('AudioWorklet停止エラー:', e);
        }
      }

      // オーディオグラフの切断
      await this.disconnectAudioGraph();
      
      // マイクトラックの停止
      this.stopMediaTracks();
    } catch (err) {
      this.log.warn('AudioSystemMediaRec: 録音停止エラー', err);
      this.notifyError('stopRecording', err);
      
      // エラーが発生してもリソースは解放
      await this.releaseResources();
      throw err;
    }
  }

  /**
   * リソースの解放
   */
  dispose(): void {
    this.log.info('AudioSystemMediaRec: リソース解放');
    this.isRecording = false;

    // イベントハンドラ解除
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }

    try {
      // EnhancedEngineのリソース解放
      if (this.enhancedEngine) {
        this.enhancedEngine.dispose();
        this.enhancedEngine = undefined;
      }

      // オーディオグラフの切断
      this.disconnectAudioGraph();
      
      // マイクトラックの停止
      this.stopMediaTracks();

      // AudioContextの終了
      if (this.ctx && this.ctx.state !== 'closed') {
        this.ctx.close().catch(e => {
          this.log.warn('AudioContext close error:', e);
        });
        this.log.info('AudioSystemMediaRec: AudioContext閉じました');
      }
    } catch (e) {
      this.log.warn('AudioSystemMediaRec: dispose error', e);
      this.notifyError('dispose', e);
    }
  }

  /* ──────────────── プライベートメソッド ──────────────── */

  /**
   * オーディオグラフの切断
   */
  private async disconnectAudioGraph(): Promise<void> {
    try {
      // AudioWorklet/ScriptProcessorの切断
      if (this.audioWorklet) {
        this.audioWorklet.disconnect();
        this.audioWorklet = undefined;
      }
      
      if (this.scriptProcessor) {
        this.scriptProcessor.disconnect();
        this.scriptProcessor = undefined;
      }

      // ソースノードの切断
      if (this.source) {
        this.source.disconnect();
        this.source = undefined;
      }
    } catch (e) {
      this.log.warn('オーディオグラフ切断エラー:', e);
    }
  }

  /**
   * メディアトラックの停止
   */
  private stopMediaTracks(): void {
    if (this.stream) {
      try {
        this.stream.getTracks().forEach(track => {
          track.stop();
        });
        this.log.info('AudioSystemMediaRec: マイクトラック停止');
      } catch (e) {
        this.log.warn('マイクトラック停止エラー:', e);
      }
      this.stream = undefined;
    }
  }

  /**
   * すべてのリソースの解放
   */
  private async releaseResources(): Promise<void> {
    // 録音が進行中なら停止
    if (this.isRecording) {
      this.isRecording = false;
      
      if (this.enhancedEngine) {
        try {
          await this.enhancedEngine.stop();
        } catch (e) {
          this.log.warn('EnhancedEngine停止エラー:', e);
        }
      }
    }
    
    // オーディオグラフの切断
    await this.disconnectAudioGraph();
    
    // メディアトラックの停止
    this.stopMediaTracks();
    
    // EnhancedEngineの解放
    if (this.enhancedEngine) {
      this.enhancedEngine.dispose();
      this.enhancedEngine = undefined;
    }
  }

  /**
   * AudioWorkletの初期化
   */
  private initAudioWorklet(): void {
    try {
      this.audioWorklet = new AudioWorkletNode(this.ctx, 'audio-processor');
      this.audioWorklet.port.onmessage = event => {
        if (event.data.type === 'process' && event.data.buffer && this.isRecording) {
          // バッファを取得し、エネルギー値を計算してログ出力
          const buffer = event.data.buffer;
          const energy = this.calculateEnergy(buffer);
          this.log.info(
            `AudioSystemMediaRec: バッファ受信 ${
              buffer.length
            } サンプル, エネルギー: ${energy.toFixed(4)}`
          );

          // コールバックで FusionCore へ転送
          if (this.onAudioProcess) {
            this.onAudioProcess(buffer);
          }
        }
      };

      // 接続
      if (this.source && this.audioWorklet) {
        this.source.connect(this.audioWorklet);
        this.audioWorklet.connect(this.ctx.destination);
      }
      this.log.info('AudioSystemMediaRec: AudioWorklet initialized');
    } catch (error) {
      this.log.error('AudioWorklet初期化エラー:', error);
      this.notifyError('initAudioWorklet', error);
      throw error;
    }
  }

  /**
   * ScriptProcessorの初期化
   */
  private initScriptProcessor(): void {
    try {
      // ScriptProcessor は非推奨だが、AudioWorklet 未対応ブラウザ用のフォールバック
      this.scriptProcessor = this.ctx.createScriptProcessor(4096, 1, 1);
      this.scriptProcessor.onaudioprocess = e => {
        if (!this.isRecording) return;

        // チャンネルデータをコピー
        const buffer = new Float32Array(e.inputBuffer.getChannelData(0));

        // エネルギー値をログ出力
        const energy = this.calculateEnergy(buffer);
        this.log.info(
          `AudioSystemMediaRec: バッファ受信 ${buffer.length} サンプル, エネルギー: ${energy.toFixed(
            4
          )}`
        );

        // コールバックで FusionCore へ転送
        if (this.onAudioProcess) {
          this.onAudioProcess(buffer);
        }
      };

      if (this.source && this.scriptProcessor) {
        this.source.connect(this.scriptProcessor);
        this.scriptProcessor.connect(this.ctx.destination);
      }
      this.log.info('AudioSystemMediaRec: ScriptProcessor initialized (fallback)');
    } catch (error) {
      this.log.error('ScriptProcessor初期化エラー:', error);
      this.notifyError('initScriptProcessor', error);
      throw error;
    }
  }

  /**
   * デバイス一覧の更新
   */
  private async refreshDevices(): Promise<void> {
    try {
      // マイク権限取得のため一度getUserMediaを呼ぶ
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(track => track.stop());

      // デバイス一覧取得
      const infos = await navigator.mediaDevices.enumerateDevices();
      this.devices = infos
        .filter(d => d.kind === 'audioinput')
        .map(d => ({
          id: d.deviceId,
          label: d.label || `マイク ${d.deviceId.slice(0, 4)}...`,
          groupId: d.groupId,
        }));

      if (this.devices.length === 0) {
        throw new Error('マイクデバイスが見つかりません');
      }

      // アクティブデバイスの更新
      if (!this.activeDevice || !this.devices.some(d => d.id === this.activeDevice!.id)) {
        this.activeDevice = this.devices[0];
      }

      // デバイス変更通知
      if (this.onDeviceChange) {
        this.onDeviceChange(this.devices);
      }
    } catch (error) {
      this.log.error('デバイス一覧の取得に失敗しました', error);
      this.notifyError('refreshDevices', error);
      throw error;
    }
  }

  /**
   * デバイスの接続テスト
   * @param device テスト対象のデバイス情報
   */
  private async testDevice(device: DeviceInfo): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: device.id } },
      });
      stream.getTracks().forEach(t => t.stop());
    } catch (error) {
      this.log.error(`デバイステストエラー: ${device.label}`, error);
      this.notifyError('testDevice', error);
      throw error;
    }
  }

  /**
   * エネルギー計算ユーティリティ
   * @param buffer オーディオバッファ
   * @returns エネルギー値
   */
  private calculateEnergy(buffer: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      sum += buffer[i] * buffer[i];
    }
    return Math.sqrt(sum / buffer.length);
  }
}