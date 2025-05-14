/**
 * WorkletAudioEngine.ts
 * オーディオエンジン実装（AudioWorklet、ScriptProcessor、MediaRecorder）
 */
import { Logger } from './Logger';
import { DeviceInfo, AudioEngine } from './types';

/**
 * AudioWorkletを使用するオーディオエンジン
 */
export class WorkletAudioEngine implements AudioEngine {
  onAudioProcess: ((buffer: Float32Array) => void) | null = null;
  private audioContext?: AudioContext;
  private workletNode?: AudioWorkletNode;
  private mediaStream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletLoaded = false;
  private log: Logger;

  constructor(debug: boolean = false) {
    this.log = new Logger(debug);
  }

  async initialize(context: AudioContext): Promise<void> {
    this.audioContext = context;
    if (!this.workletLoaded) {
      try {
        // ワークレットのパスは環境に合わせて調整が必要
        // 通常は相対パスではなく、プロジェクトのパブリックパスを使用
        const workletPath = '/fusionCore/worklets/recorder-worklet.js';
        await this.audioContext.audioWorklet.addModule(workletPath);
        this.workletLoaded = true;
        this.log.info('Recorderワークレットロード完了');
      } catch (error) {
        this.log.error('ワークレットロードエラー:', error);
        throw error;
      }
    }
  }

  async start(device: DeviceInfo): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioEngineが初期化されていません');
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.id },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: {
          sampleRate: this.audioContext.sampleRate,
        },
      });
      this.workletNode.port.onmessage = e => {
        if (e.data.eventType === 'audioFrame' && this.onAudioProcess) {
          this.onAudioProcess(new Float32Array(e.data.audioData));
        }
      };
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);
      this.log.info('WorkletEngine録音開始');
    } catch (error) {
      this.log.error('WorkletEngine開始エラー:', error);
      await this.releaseResources();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.releaseResources();
    this.log.info('WorkletEngine録音停止');
  }

  dispose(): void {
    this.releaseResources().catch(e => this.log.error('リソース解放エラー:', e));
    this.audioContext = undefined;
  }

  private async releaseResources(): Promise<void> {
    if (this.sourceNode && this.workletNode) {
      this.sourceNode.disconnect(this.workletNode);
      this.workletNode.disconnect();
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = undefined;
    }
    this.sourceNode = undefined;
    this.workletNode = undefined;
  }
}

/**
 * ScriptProcessorNodeを使用するオーディオエンジン（レガシーサポート用）
 */
export class ScriptProcessorEngine implements AudioEngine {
  onAudioProcess: ((buffer: Float32Array) => void) | null = null;
  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private sourceNode?: MediaStreamAudioSourceNode;
  private processorNode?: ScriptProcessorNode;
  private log: Logger;

  constructor(debug: boolean = false) {
    this.log = new Logger(debug);
  }

  async initialize(context: AudioContext): Promise<void> {
    this.audioContext = context;
    this.log.info('ScriptProcessorEngine初期化完了');
  }

  async start(device: DeviceInfo): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioEngineが初期化されていません');
    }
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.id },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processorNode.onaudioprocess = event => {
        const inputBuffer = event.inputBuffer.getChannelData(0);
        const bufferCopy = new Float32Array(inputBuffer.length);
        bufferCopy.set(inputBuffer);
        if (this.onAudioProcess) {
          this.onAudioProcess(bufferCopy);
        }
      };
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);
      this.log.info('ScriptProcessorEngine録音開始');
    } catch (error) {
      this.log.error('ScriptProcessorEngine開始エラー:', error);
      await this.releaseResources();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.releaseResources();
    this.log.info('ScriptProcessorEngine録音停止');
  }

  dispose(): void {
    this.releaseResources().catch(e => this.log.error('リソース解放エラー:', e));
    this.audioContext = undefined;
  }

  private async releaseResources(): Promise<void> {
    if (this.sourceNode && this.processorNode) {
      this.sourceNode.disconnect(this.processorNode);
      this.processorNode.disconnect();
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = undefined;
    }
    this.sourceNode = undefined;
    this.processorNode = undefined;
  }
}

/**
 * MediaRecorderを使用するオーディオエンジン（iOS対応用）
 */
export class MediaRecorderEngine implements AudioEngine {
  onAudioProcess: ((buffer: Float32Array) => void) | null = null;
  private audioContext?: AudioContext;
  private mediaStream?: MediaStream;
  private mediaRecorder?: MediaRecorder;
  private recordedChunks: Blob[] = [];
  private processor?: ScriptProcessorNode;
  private sourceNode?: MediaStreamAudioSourceNode;
  private log: Logger;

  constructor(debug: boolean = false) {
    this.log = new Logger(debug);
  }

  async initialize(context: AudioContext): Promise<void> {
    this.audioContext = context;
    this.log.info('MediaRecorderEngine初期化完了');
  }

  async start(device: DeviceInfo): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioEngineが初期化されていません');
    }
    
    if (!('MediaRecorder' in window)) {
      throw new Error('MediaRecorderがサポートされていない環境です');
    }
    
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.id },
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      
      // MediaRecorder設定
      const mimeType = this.getSupportedMimeType();
      if (!mimeType) {
        throw new Error('サポートされているオーディオMIMEタイプが見つかりません');
      }
      
      this.mediaRecorder = new MediaRecorder(this.mediaStream, { mimeType });
      this.mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          this.recordedChunks.push(event.data);
        }
      };
      
      this.mediaRecorder.onstop = () => {
        this.log.info('MediaRecorder停止完了');
      };
      
      this.mediaRecorder.onerror = event => {
        this.log.error('MediaRecorderエラー:', event);
      };
      
      // オーディオ解析用のScriptProcessor設定
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = event => {
        if (this.onAudioProcess) {
          const inputBuffer = event.inputBuffer.getChannelData(0);
          const bufferCopy = new Float32Array(inputBuffer.length);
          bufferCopy.set(inputBuffer);
          this.onAudioProcess(bufferCopy);
        }
      };
      
      this.sourceNode.connect(this.processor);
      this.processor.connect(this.audioContext.destination);
      
      // 録音開始
      this.mediaRecorder.start(100); // 100msごとにデータ取得
      this.log.info('MediaRecorderEngine録音開始');
    } catch (error) {
      this.log.error('MediaRecorderEngine開始エラー:', error);
      await this.releaseResources();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      return new Promise<void>((resolve, reject) => {
        const originalOnStop = this.mediaRecorder!.onstop;
        
        this.mediaRecorder!.onstop = async (event) => {
          // 元のハンドラーがある場合は呼び出す
          if (originalOnStop) {
            // Non-nullアサーションで値が必ず存在することを示す
            originalOnStop.call(this.mediaRecorder!, event as Event);
          }
          
          try {
            await this.releaseResources();
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        
        this.mediaRecorder!.stop();
      });
    } else {
      await this.releaseResources();
      return Promise.resolve();
    }
  }

  dispose(): void {
    this.releaseResources().catch(e => this.log.error('リソース解放エラー:', e));
    this.audioContext = undefined;
  }

  /**
   * 録音データをBlob形式で取得
   */
  getRecordedBlob(): Blob | null {
    if (this.recordedChunks.length === 0) {
      return null;
    }
    
    const mimeType = this.getSupportedMimeType() || 'audio/webm';
    return new Blob(this.recordedChunks, { type: mimeType });
  }

  private async releaseResources(): Promise<void> {
    if (this.sourceNode && this.processor) {
      this.sourceNode.disconnect(this.processor);
      this.processor.disconnect();
    }
    
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = undefined;
    }
    
    this.sourceNode = undefined;
    this.processor = undefined;
    this.mediaRecorder = undefined;
  }

  private getSupportedMimeType(): string | null {
    const types = [
      'audio/webm',
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/mpeg'
    ];
    
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }
    
    return null;
  }
}