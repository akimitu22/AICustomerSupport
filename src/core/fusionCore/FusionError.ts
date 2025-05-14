/**
 * FusionError.ts
 * システム全体で使用する共通エラー定義
 */

/**
 * FusionErrorの基底クラス
 */
export class FusionError extends Error {
  constructor(
    public readonly context: string,
    message: string,
    public readonly userMessage: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * マイク権限関連のエラー
 */
export class PermissionError extends FusionError {}

/**
 * デバイス関連のエラー
 */
export class DeviceError extends FusionError {}

/**
 * Workerスレッド関連のエラー
 */
export class WorkerError extends FusionError {}

/**
 * ファイルシステム操作関連のエラー
 */
export class FileSystemError extends FusionError {}