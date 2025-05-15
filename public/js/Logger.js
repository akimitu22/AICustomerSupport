/**
 * Logger - デバッグ／情報ログを統一的に管理するユーティリティ
 * デバッグモード時のみログ出力を行います。
 */
export class Logger {
  constructor(debug = false) {
    this.debugEnabled = debug;
  }
  /** 情報ログ */
  info(...args) {
    if (this.debugEnabled) {
      console.info('[FusionCore][INFO]', ...args);
    }
  }
  /** 警告ログ */
  warn(...args) {
    if (this.debugEnabled) {
      console.warn('[FusionCore][WARN]', ...args);
    }
  }
  /** エラーログ */
  error(...args) {
    // エラーは常に出力
    console.error('[FusionCore][ERROR]', ...args);
  }
  /** デバッグログ */
  debug(...args) {
    if (this.debugEnabled) {
      console.debug('[FusionCore][DEBUG]', ...args);
    }
  }
}
//# sourceMappingURL=Logger.js.map
