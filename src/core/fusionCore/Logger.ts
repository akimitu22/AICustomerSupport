/**
 * Logger - デバッグ／情報ログを統一的に管理するユーティリティ
 * デバッグモード時のみログ出力を行います。
 */
export class Logger {
  private debugEnabled: boolean;

  constructor(debug: boolean = false) {
    this.debugEnabled = debug;
  }

  /** 情報ログ */
  info(...args: any[]): void {
    if (this.debugEnabled) {
      console.info('[FusionCore][INFO]', ...args);
    }
  }

  /** 警告ログ */
  warn(...args: any[]): void {
    if (this.debugEnabled) {
      console.warn('[FusionCore][WARN]', ...args);
    }
  }

  /** エラーログ */
  error(...args: any[]): void {
    // エラーは常に出力
    console.error('[FusionCore][ERROR]', ...args);
  }

  /** デバッグログ */
  debug(...args: any[]): void {
    if (this.debugEnabled) {
      console.debug('[FusionCore][DEBUG]', ...args);
    }
  }
}
