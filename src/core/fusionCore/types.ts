/**
 * types.ts
 * システム全体で共有される型定義
 */

/**
 * システムが検出した環境の機能サポート状況
 */
export interface CapabilitiesResult {
  // オーディオ処理関連
  hasAudioWorklet: boolean;
  hasScriptProcessor: boolean;
  hasMediaRecorder?: boolean;

  // 非同期処理関連
  hasWorker: boolean;

  // ストレージ関連
  hasOPFS: boolean;

  // ブラウザ・デバイス検出
  isSafari: boolean;
  isIOS: boolean;
  isMobile: boolean;
  cpuCores: number;
}

/**
 * マイクデバイス情報
 */
export interface DeviceInfo {
  id: string;
  label: string;
  groupId: string;
}

/**
 * システムの性能プロファイル
 */
export type Profile = 'low' | 'balanced' | 'high' | 'auto';

/**
 * コアオプション設定
 */
export interface CoreOptions {
  profile?: Profile;
  sampleRate?: number;
  maxDurationSec?: number;
  vadSensitivity?: number;
  silenceTimeoutMs?: number;
  debug?: boolean;
}

/**
 * オーディオシステムオプション
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
 * オーディオエンジンインターフェース
 */
export interface AudioEngine {
  onAudioProcess: ((buffer: Float32Array) => void) | null;
  initialize(context: AudioContext): Promise<void>;
  start(device: DeviceInfo): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

/**
 * オーディオシステムインターフェース
 */
export interface AudioSystem {
  initialize(): Promise<void>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<void>;
  getDevices(): Promise<DeviceInfo[]>;
  selectDevice(deviceId: string): Promise<boolean>;
  dispose(): void;
  unlockAudioContext(): Promise<void>;
  onAudioProcess?: (buffer: Float32Array) => void;
  onDeviceChange?: (devices: DeviceInfo[]) => void;
  onError?: (context: string, error: any) => void;
}

/**
 * コアイベントの種類
 */
export type CoreEvent =
  | 'initializing'
  | 'ready'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'processingProgress'
  | 'vadData'
  | 'speechStart'
  | 'speechEnd'
  | 'deviceChange'
  | 'idle';

/**
 * バッファマネージャーのオプション設定
 */
export interface BufferManagerOptions {
  sampleRate: number;
  capabilities: CapabilitiesResult;
  maxSamples?: number;
  debug?: boolean;
}

/**
 * Origin Private File System操作のインターフェース
 */
export interface OPFSManager {
  initialize(): Promise<void>;
  saveFile(buffer: ArrayBuffer, fileName: string): Promise<void>;
  appendToFile(buffer: ArrayBuffer, fileName: string): Promise<void>;
  readFile(fileName: string): Promise<ArrayBuffer>;
  deleteFile(fileName: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * CoreStateの型定義
 */
export type CoreState =
  | { state: 'idle' }
  | { state: 'initializing' }
  | { state: 'ready' }
  | { state: 'starting' }
  | { state: 'recording' }
  | { state: 'stopping' }
  | { state: 'error'; error: Error };

/**
 * 状態遷移の型定義
 */
export type StateTransition =
  | { from: 'idle'; to: 'initializing' }
  | { from: 'initializing'; to: 'ready' | 'error' }
  | { from: 'ready'; to: 'starting' }
  | { from: 'starting'; to: 'recording' | 'error' }
  | { from: 'recording'; to: 'stopping' }
  | { from: 'stopping'; to: 'ready' | 'error' }
  | { from: 'error'; to: 'idle' };

/**
 * 録音オプション設定
 */
export interface RecordingOptions {
  format?: string;
  sampleRate?: number;
  mimeType?: string;
  channelCount?: number;
  autoGainControl?: boolean;
  noiseSuppression?: boolean;
  echoCancellation?: boolean;
  bitRate?: number;
  maxDurationMs?: number;
  chunkDurationMs?: number;
}

/**
 * レコーダーの状態
 */
export enum RecorderStatus {
  INACTIVE = 'inactive',
  RECORDING = 'recording',
  PAUSED = 'paused',
  PROCESSING = 'processing',
  ERROR = 'error'
}

/**
 * 環境検出ユーティリティ
 */
export class Capabilities {
  static detect(): CapabilitiesResult {
    // ブラウザ環境チェック
    const isBrowser = typeof window !== 'undefined' && typeof navigator !== 'undefined';
    
    if (!isBrowser) {
      // Node.js環境またはその他非ブラウザ環境でのデフォルト値
      return {
        hasAudioWorklet: false,
        hasScriptProcessor: false,
        hasMediaRecorder: false,
        hasWorker: false,
        hasOPFS: false,
        isSafari: false,
        isIOS: false,
        isMobile: false,
        cpuCores: 1
      };
    }

    const audioContext = window.AudioContext || (window as any).webkitAudioContext;
    const hasAudioContext = typeof audioContext === 'function';

    // iOS検出
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;

    // Safari検出
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

    // モバイル検出
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent
    );

    // CPU コア数
    const cpuCores = navigator.hardwareConcurrency || 2;

    // 機能検出
    const hasAudioWorklet = hasAudioContext && 'audioWorklet' in AudioContext.prototype;
    const hasScriptProcessor =
      hasAudioContext &&
      ('createScriptProcessor' in AudioContext.prototype ||
        'createJavaScriptNode' in AudioContext.prototype);
    
    // MediaRecorder サポート検出
    const hasMediaRecorder = typeof MediaRecorder !== 'undefined' && 
      MediaRecorder.isTypeSupported && 
      (MediaRecorder.isTypeSupported('audio/webm') || 
       MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ||
       MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'));
    
    const hasWorker = typeof Worker !== 'undefined';
    
    // Origin Private File System サポート検出
    const hasOPFS =
      'storage' in navigator &&
      'getDirectory' in navigator.storage;

    return {
      hasAudioWorklet,
      hasScriptProcessor,
      hasMediaRecorder,
      hasWorker,
      hasOPFS,
      isSafari,
      isIOS,
      isMobile,
      cpuCores,
    };
  }
}