/**
 * EnhancedMediaRecorderEngine.ts
 * iOS対応の強化されたMediaRecorderエンジン実装
 */
import { Logger } from './Logger';
import { DeviceInfo, AudioEngine } from './types';
import { AudioBlobManager } from './AudioBlobManager';

/**
 * iOSを含む幅広い環境に対応した強化MediaRecorderエンジン
 */
export class EnhancedMediaRecorderEngine implements AudioEngine {
  onAudioProcess: ((buffer: Float32Array) => void) | null = null;
  onError?: (context: string, error: any) => void;
  
  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private mediaRecorder?: MediaRecorder;
  private recordedChunks: Blob[] = [];
  private processor?: ScriptProcessorNode;
  private sourceNode?: MediaStreamAudioSourceNode;
  private log: Logger;
  private recordingInterval?: number;
  private visibilityChangeHandler: (() => void) | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  private isRecording = false;
  private blobManager: AudioBlobManager;
  private iosVersion = 0;
  
  // デバッグモードのフラグ（一元管理）
  private debugMode = false;
  
  // iOS対応のMIMEタイプ設定
  private preferredMimeTypes = ['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/ogg'];
  private chunkDurationMs = 300000; // デフォルト5分チャンク
  private selectedMimeType = '';
  
  // メモリ管理設定
  private maxChunks = 20; // 保持する最大チャンク数
  private maxTotalSize = 50 * 1024 * 1024; // 最大合計サイズ (50MB)
  private totalSize = 0;

  /**
   * コンストラクタ
   * @param debug デバッグモード有効化フラグ
   */
  constructor(debug: boolean = false) {
    this.log = new Logger(debug);
    // デバッグモードを保存
    this.debugMode = debug;
    
    // 環境検出
    const isIOS = this.isIOSDevice();
    this.iosVersion = isIOS ? this.detectIOSVersion() : 0;
    
    // 環境に応じた設定調整
    if (isIOS) {
      this.log.info(`iOS環境検出: バージョン ${this.iosVersion}`);
      if (this.iosVersion < 15) {
        // iOS 14以下では短いチャンク間隔を使用
        this.chunkDurationMs = 60000; // 1分
        this.maxChunks = 10; // チャンク数も制限
        this.log.info('iOS 14以下: 短いチャンク間隔に設定 (1分)');
      }
    }
    
    // BlobManagerの初期化
    this.blobManager = new AudioBlobManager('audio/mp4', debug);
    
    // 可視性変更ハンドラのセットアップ
    this.setupVisibilityChangeHandler();
  }

  /**
   * iOS端末かどうかを検出
   */
  private isIOSDevice(): boolean {
    return /(iPad|iPhone|iPod)/i.test(navigator.userAgent) && !(window as any).MSStream;
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
        
        // 録音状態の回復 (iOS対策)
        this.recoverRecordingIfNeeded();
      }
    };
    
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);
  }

  /**
   * AudioContextの再開
   */
  private resumeAudioContext(): void {
    if (this.audioContext?.state === 'suspended') {
      this.log.info('AudioContextを再開します');
      this.audioContext.resume().catch(err => {
        this.log.warn('AudioContext再開失敗:', err);
        this.notifyError('resumeAudioContext', err);
      });
    }
  }

  /**
   * 録音状態の回復 (iOS用)
   */
  private recoverRecordingIfNeeded(): void {
    // 録音中にバックグラウンドに行った場合、iOSではMediaRecorderが停止している可能性がある
    if (this.isRecording && 
        this.mediaRecorder && 
        this.mediaRecorder.state === 'inactive' && 
        this.reconnectAttempts < this.maxReconnectAttempts) {
      
      this.log.info('バックグラウンドから戻り、録音を再開します');
      this.reconnectAttempts++;
      
      try {
        // 新しいMediaRecorderを作成して再開
        if (this.mediaStream) {
          this.initMediaRecorder(this.mediaStream);
          this.mediaRecorder?.start(100);
          this.log.info('MediaRecorderを再開しました');
        } else {
          throw new Error('MediaStreamが利用できないため録音を再開できません');
        }
      } catch (err) {
        this.log.error('録音の再開に失敗:', err);
        this.notifyError('recoverRecording', err);
      }
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
   * MIMEタイプの安全な検出
   */
  private getSupportedMimeType(): string {
    // MediaRecorderがグローバルに存在するか確認
    if (typeof MediaRecorder === 'undefined') {
      this.log.warn('MediaRecorderが利用できない環境です');
      return '';
    }
    
    // iOSのバグを回避するホワイトリスト方式
    for (const mimeType of this.preferredMimeTypes) {
      try {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          this.log.info(`サポートされているMIMEタイプ: ${mimeType}`);
          return mimeType;
        }
      } catch (e) {
        // isTypeSupportedがエラーを投げる場合もある
        this.log.warn(`MIMEタイプチェックエラー: ${mimeType}`, e);
      }
    }
    
    // フォールバック
    this.log.warn('優先MIMEタイプが見つからなかったためデフォルトを使用');
    return '';
  }

  /**
   * エンジンの初期化
   * @param context AudioContext
   */
  async initialize(context: AudioContext): Promise<void> {
    try {
      this.audioContext = context;
      
      // iOS環境の場合、特別な処理を適用
      const isIOS = this.isIOSDevice();
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      
      if (isIOS || isSafari) {
        this.log.info('iOS/Safari環境を検出しました - 特別な処理を適用します');
        
        // iOS環境では最適なMIMEタイプを事前に検出
        this.selectedMimeType = this.getSupportedMimeType();
        
        // BlobManagerにMIMEタイプを設定
        if (this.selectedMimeType) {
          // デバッグモードは保存された値を直接使用
          this.blobManager = new AudioBlobManager(this.selectedMimeType, this.debugMode);
        }
        
        // iOS 15未満の場合は警告
        if (isIOS && this.iosVersion < 15) {
          this.log.warn('iOS 15未満では録音に制限があります (最大推奨録音時間: 3分)');
        }
      }
      
      this.log.info('EnhancedMediaRecorderEngine初期化完了');
    } catch (error) {
      this.log.error('初期化エラー:', error);
      this.notifyError('initialize', error);
      throw error;
    }
  }

  /**
   * デバッグモードの値を取得する
   * @returns デバッグモードの設定値
   */
  private getDebugMode(): boolean {
    return this.debugMode;
  }

  /**
   * MediaRecorderの初期化
   */
  private initMediaRecorder(stream: MediaStream): void {
    try {
      // MIMEタイプが未選択の場合は検出
      if (!this.selectedMimeType) {
        this.selectedMimeType = this.getSupportedMimeType();
      }
      
      // MediaRecorderの生成
      const options: MediaRecorderOptions = {};
      if (this.selectedMimeType) {
        options.mimeType = this.selectedMimeType;
      }
      
      this.mediaRecorder = new MediaRecorder(stream, options);
      
      // データ取得イベントハンドラ
      this.mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          // チャンクサイズが0でないことを確認
          this.handleRecordedChunk(event.data);
        }
      };
      
      // 停止イベントハンドラ
      this.mediaRecorder.onstop = () => {
        this.log.info('MediaRecorder停止完了');
      };
      
      // エラーイベントハンドラ
      this.mediaRecorder.onerror = event => {
        this.log.error('MediaRecorderエラー:', event);
        this.notifyError('mediaRecorder', event);
      };
    } catch (error) {
      this.log.error('MediaRecorder初期化エラー:', error);
      this.notifyError('initMediaRecorder', error);
      throw error;
    }
  }

  /**
   * 録音チャンクの処理
   */
  private handleRecordedChunk(chunk: Blob): void {
    // サイズと数を管理
    this.totalSize += chunk.size;
    this.recordedChunks.push(chunk);
    
    this.log.info(
      `録音データ取得: ${chunk.size} バイト, 合計: ${this.recordedChunks.length} チャンク, 総サイズ: ${this.totalSize / 1024} KB`
    );
    
    // BlobManagerに追加
    this.blobManager.addChunk(chunk);
    
    // メモリ管理
    this.manageBlobMemory();
  }

  /**
   * Blobデータのメモリ管理
   */
  private manageBlobMemory(): void {
    // チャンク数による制限
    if (this.recordedChunks.length > this.maxChunks) {
      const excessChunks = this.recordedChunks.length - this.maxChunks;
      
      // 古いチャンクを削除して総サイズを調整
      for (let i = 0; i < excessChunks; i++) {
        this.totalSize -= this.recordedChunks[0].size;
        this.recordedChunks.shift();
      }
      
      this.log.info(`メモリ管理: ${excessChunks}個の古いチャンクを削除`);
    }
    
    // 総サイズによる制限
    if (this.totalSize > this.maxTotalSize) {
      let removedSize = 0;
      let removedCount = 0;
      
      // サイズ制限を下回るまで古いチャンクを削除
      while (this.recordedChunks.length > 0 && this.totalSize - removedSize > this.maxTotalSize) {
        removedSize += this.recordedChunks[0].size;
        this.recordedChunks.shift();
        removedCount++;
      }
      
      this.totalSize -= removedSize;
      this.log.info(`メモリ管理: サイズ制限超過により${removedCount}個(${removedSize / 1024} KB)のチャンクを削除`);
    }
  }

  /**
   * 録音開始
   * @param device マイクデバイス情報
   */
  async start(device: DeviceInfo): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioEngineが初期化されていません');
    }
    
    if (!('MediaRecorder' in window)) {
      throw new Error('MediaRecorderがサポートされていない環境です');
    }
    
    try {
      // 録音準備と開始
      this.isRecording = true;
      this.reconnectAttempts = 0;
      this.recordedChunks = [];
      this.totalSize = 0;
      
      // BlobManagerをリセット
      this.blobManager.dispose();
      // デバッグモードは直接値を使用
      this.blobManager = new AudioBlobManager(this.selectedMimeType || 'audio/mp4', this.debugMode);
      
      // マイク取得オプション
      const constraints: MediaStreamConstraints = {
        audio: {
          deviceId: { exact: device.id },
          // iOS向けにエコーキャンセルと自動利得調整を有効化
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };
      
      // マイク取得
      this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      
      // AudioContextの準備
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      // MediaRecorderの初期化
      this.initMediaRecorder(this.mediaStream);
      
      // オーディオ解析用のScriptProcessor設定
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = event => {
        if (this.onAudioProcess && this.isRecording) {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          const bufferCopy = new Float32Array(inputBuffer.length);
          bufferCopy.set(inputBuffer);
          this.onAudioProcess(bufferCopy);
        }
      };
      
      this.sourceNode.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      
      // チャンク録音のためのインターバル設定（iOS対策）
      // 安全のため短いインターバルでrequestDataを呼び出すようにし、
      // iOS 15未満の場合はさらに短いインターバルを使用
      const intervalTime = this.isIOSDevice() && this.iosVersion < 15 
        ? Math.min(60000, this.chunkDurationMs) // 最大1分
        : this.chunkDurationMs;
        
      this.recordingInterval = window.setInterval(() => {
        if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
          try {
            this.log.info('録音チャンク取得中...');
            this.mediaRecorder.requestData();
          } catch (e) {
            // 古いiOS/SafariではrequestDataがサポートされていない場合がある
            this.log.warn('requestData not supported:', e);
          }
        }
      }, intervalTime);
      
      // 録音開始 - より頻繁にデータを取得するように調整 (iOS対応)
      // iOS 15未満では短い間隔でデータを取得
      const timeslice = this.isIOSDevice() && this.iosVersion < 15 ? 500 : 1000;
      if (this.mediaRecorder) {
        this.mediaRecorder.start(timeslice);
        this.log.info(`EnhancedMediaRecorderEngine録音開始 (間隔: ${timeslice}ms)`);
      } else {
        throw new Error('MediaRecorderが初期化されていません');
      }
    } catch (error) {
      this.isRecording = false;
      this.log.error('EnhancedMediaRecorderEngine開始エラー:', error);
      this.notifyError('start', error);
      await this.releaseResources();
      throw error;
    }
  }

  /**
   * 録音停止
   */
  async stop(): Promise<void> {
    try {
      this.isRecording = false;
      
      // インターバルクリア
      if (this.recordingInterval) {
        clearInterval(this.recordingInterval);
        this.recordingInterval = undefined;
      }
      
      // MediaRecorderの停止
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        return new Promise<void>((resolve, reject) => {
          // ローカル変数で参照を保持
          const recorder = this.mediaRecorder;
          
          if (!recorder) {
            resolve();
            return;
          }
          
          // 元のハンドラーを保持
          const originalOnStop = recorder.onstop;
          
          // 停止時のハンドラーを設定
          recorder.onstop = async (event) => {
            try {
              // 元のハンドラーがある場合は呼び出す
              if (originalOnStop) {
                try {
                  originalOnStop.call(recorder, event as Event);
                } catch (callError) {
                  this.log.warn('元のonstopハンドラー呼び出しエラー:', callError);
                }
              }
              
              // リソースの解放とPromiseの解決
              await this.releaseResources();
              resolve();
            } catch (error) {
              this.log.error('停止処理中のエラー:', error);
              this.notifyError('stopHandler', error);
              reject(error);
            }
          };
          
          // 最後のデータ取得を要求
          try {
            recorder.requestData();
          } catch (e) {
            this.log.warn('最終データ取得エラー:', e);
          }
          
          // 録音停止
          try {
            recorder.stop();
          } catch (stopError) {
            this.log.error('MediaRecorder停止エラー:', stopError);
            this.notifyError('stopMediaRecorder', stopError);
            
            // エラーが発生しても処理を継続
            this.releaseResources().then(resolve).catch(reject);
          }
        });
      } else {
        // MediaRecorderが既に停止している場合はリソースを解放
        await this.releaseResources();
      }
    } catch (error) {
      this.log.error('録音停止中の予期しないエラー:', error);
      this.notifyError('stop', error);
      
      // エラーが発生してもリソースは解放
      await this.releaseResources();
      throw error;
    }
  }

  /**
   * リソースの解放
   */
  dispose(): void {
    this.isRecording = false;
    
    // イベントハンドラ解除
    if (this.visibilityChangeHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityChangeHandler);
      this.visibilityChangeHandler = null;
    }
    
    // インターバルクリア
    if (this.recordingInterval) {
      clearInterval(this.recordingInterval);
      this.recordingInterval = undefined;
    }
    
    // BlobManagerの解放
    this.blobManager.dispose();
    
    // オーディオリソースの解放
    this.releaseResources().catch(e => {
      this.log.error('リソース解放エラー:', e);
      this.notifyError('dispose', e);
    });
    
    this.audioContext = undefined;
  }

  /**
   * 録音データをBlob形式で取得
   * @returns 録音データのBlob
   */
  getRecordedBlob(): Blob | null {
    // BlobManagerから取得（優先）
    const blobFromManager = this.blobManager.getBlob();
    if (blobFromManager && blobFromManager.size > 0) {
      return blobFromManager;
    }
    
    // フォールバック: 内部管理のチャンクから取得
    if (this.recordedChunks.length === 0) {
      return null;
    }
    
    const mimeType = this.selectedMimeType || 'audio/mp4';
    return new Blob(this.recordedChunks, { type: mimeType });
  }

  /**
   * 録音データのMediaSourceURL取得
   * @returns MediaSource URL
   */
  async getMediaSourceUrl(): Promise<string> {
    return this.blobManager.createMediaSourceUrl();
  }

  /**
   * すべての録音チャンクをクリア
   */
  clearRecordedChunks(): void {
    this.recordedChunks = [];
    this.totalSize = 0;
    this.blobManager.dispose();
    // デバッグモードは直接値を使用
    this.blobManager = new AudioBlobManager(this.selectedMimeType || 'audio/mp4', this.debugMode);
  }

  /**
   * 選択されたMIMEタイプを取得
   * @returns 選択されたMIMEタイプ
   */
  getSelectedMimeType(): string {
    return this.selectedMimeType;
  }

  /**
   * チャンク録音間隔の設定
   * @param durationMs 録音間隔（ミリ秒）
   */
  setChunkDuration(durationMs: number): void {
    // iOS 15未満の場合は上限を設ける
    if (this.isIOSDevice() && this.iosVersion < 15) {
      this.chunkDurationMs = Math.min(60000, durationMs); // 最大1分
      this.log.info(`iOS ${this.iosVersion} 用にチャンク間隔を制限: ${this.chunkDurationMs}ms`);
    } else {
      this.chunkDurationMs = durationMs;
      this.log.info(`チャンク間隔を設定: ${this.chunkDurationMs}ms`);
    }
  }

  /**
   * オーディオリソースの解放
   */
  private async releaseResources(): Promise<void> {
    try {
      // オーディオノードの切断
      if (this.sourceNode && this.processor) {
        try {
          this.sourceNode.disconnect(this.processor);
          this.processor.disconnect();
        } catch (e) {
          this.log.warn('オーディオノード切断エラー:', e);
        }
      }
      
      // MediaRecorderの停止
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        try {
          this.mediaRecorder.stop();
        } catch (e) {
          this.log.warn('MediaRecorder停止エラー:', e);
        }
      }
      
      // MediaStreamの解放
      if (this.mediaStream) {
        this.mediaStream.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (e) {
            this.log.warn(`トラック停止エラー (kind=${track.kind}):`, e);
          }
        });
        this.mediaStream = undefined;
      }
      
      // 参照のクリア
      this.sourceNode = undefined;
      this.processor = undefined;
      this.mediaRecorder = undefined;
      
      this.log.info('オーディオリソースを解放しました');
    } catch (error) {
      this.log.error('リソース解放中の予期しないエラー:', error);
      this.notifyError('releaseResources', error);
      throw error;
    }
  }
}