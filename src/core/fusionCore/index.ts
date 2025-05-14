/**
 * index.ts
 * FusionCore public API hub
 */

// コアクラスのエクスポート
export { FusionCore } from './FusionCore';
export { AudioSystemMediaRec } from './AudioSystemMediaRec';
export { EnhancedMediaRecorderEngine } from './EnhancedMediaRecorderEngine'; // 実装ファイルが必要
export { AudioBlobManager } from './AudioBlobManager'; // 実装ファイルが必要
export { StableAudioRecorder } from './StableAudioRecorder'; // 実装ファイルが必要

// ユーティリティのエクスポート
export { Logger } from './Logger';
export { BufferManager } from './storage';

// エラークラス
export { 
  FusionError, 
  PermissionError, 
  DeviceError, 
  WorkerError,
  FileSystemError 
} from './FusionError';

// 型定義
export type { 
  CapabilitiesResult, 
  DeviceInfo, 
  Profile, 
  CoreOptions,
  AudioSystem,
  CoreEvent,
  BufferManagerOptions,
  OPFSManager,
  RecordingOptions,
  RecorderStatus
} from './types';

// 環境検出ユーティリティ
export { Capabilities } from './types';