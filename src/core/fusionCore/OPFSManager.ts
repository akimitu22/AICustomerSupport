/**
 * OPFSManager.ts
 * Origin Private File System (OPFS) 操作マネージャー
 */
import { Logger } from './Logger';
import { OPFSManager as OPFSManagerInterface } from './types';
import { FileSystemError } from './FusionError';

/**
 * OriginPrivateFileSystem管理クラス
 * ブラウザのFS APIを使用した永続ストレージ
 */
export class OPFSManager implements OPFSManagerInterface {
  private available: boolean;
  private log: Logger;
  private rootDirectory: FileSystemDirectoryHandle | null = null;

  constructor(debug: boolean = false) {
    this.log = new Logger(debug);
    this.available = this.checkAvailability();
    
    if (this.available) {
      this.log.info('OPFS利用可能');
    } else {
      this.log.warn('OPFS利用不可');
    }
  }

  /**
   * 初期化メソッド
   * ルートディレクトリへのアクセスを取得
   */
  async initialize(): Promise<void> {
    if (!this.available) {
      this.log.info('OPFSは利用できないため初期化をスキップします');
      return;
    }
    
    try {
      this.rootDirectory = await navigator.storage.getDirectory();
      await this.cleanupTempFiles();
      this.log.info('OPFSを正常に初期化しました');
    } catch (error) {
      this.log.error('OPFS初期化エラー:', error);
      throw new FileSystemError(
        'initialize', 
        String(error), 
        'ファイルシステムの初期化に失敗しました'
      );
    }
  }

  /**
   * ファイル保存（新規作成または上書き）
   * @param buffer 保存するデータ
   * @param fileName ファイル名
   */
  async saveFile(buffer: ArrayBuffer, fileName: string): Promise<void> {
    if (!this.available || !this.rootDirectory) {
      throw new FileSystemError(
        'saveFile', 
        'OPFS not available or not initialized', 
        'ファイルシステムが利用できません'
      );
    }
    
    try {
      const fileHandle = await this.rootDirectory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(buffer);
      await writable.close();
      this.log.info(`ファイル保存完了: ${fileName} (${buffer.byteLength} bytes)`);
    } catch (error) {
      this.log.error('ファイル保存エラー:', error);
      throw new FileSystemError(
        'saveFile', 
        String(error), 
        'ファイルの保存に失敗しました'
      );
    }
  }

  /**
   * 既存ファイルへのデータ追加
   * @param buffer 追加するデータ
   * @param fileName ファイル名
   */
  async appendToFile(buffer: ArrayBuffer, fileName: string): Promise<void> {
    if (!this.available || !this.rootDirectory) {
      throw new FileSystemError(
        'appendToFile', 
        'OPFS not available or not initialized', 
        'ファイルシステムが利用できません'
      );
    }
    
    try {
      let fileHandle: FileSystemFileHandle;
      
      try {
        // ファイル存在確認
        fileHandle = await this.rootDirectory.getFileHandle(fileName, { create: false });
      } catch (error) {
        // ファイルが存在しない場合は新規作成
        fileHandle = await this.rootDirectory.getFileHandle(fileName, { create: true });
        this.log.info(`新規ファイル作成: ${fileName}`);
      }
      
      // ファイルサイズを取得
      const file = await fileHandle.getFile();
      const size = file.size;
      
      // 追記モードでWritableStreamを開く
      const writable = await fileHandle.createWritable({ keepExistingData: true });
      await writable.seek(size);
      await writable.write(buffer);
      await writable.close();
      
      this.log.info(`ファイル追記完了: ${fileName} (+${buffer.byteLength} bytes)`);
    } catch (error) {
      this.log.error(`ファイル追加エラー: ${fileName}`, error);
      throw new FileSystemError(
        'appendToFile', 
        String(error), 
        'ファイルへの追記に失敗しました'
      );
    }
  }

  /**
   * ファイル読み込み
   * @param fileName ファイル名
   * @returns ファイルデータのArrayBuffer
   */
  async readFile(fileName: string): Promise<ArrayBuffer> {
    return this.loadFile(fileName);
  }

  /**
   * ファイル読み込み（内部実装）
   * @param fileName ファイル名
   * @returns ファイルデータのArrayBuffer
   */
  private async loadFile(fileName: string): Promise<ArrayBuffer> {
    if (!this.available || !this.rootDirectory) {
      throw new FileSystemError(
        'loadFile', 
        'OPFS not available or not initialized', 
        'ファイルシステムが利用できません'
      );
    }
    
    try {
      const fileHandle = await this.rootDirectory.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      return await file.arrayBuffer();
    } catch (error) {
      this.log.error(`ファイル読み込みエラー: ${fileName}`, error);
      throw new FileSystemError(
        'loadFile', 
        String(error), 
        'ファイルの読み込みに失敗しました'
      );
    }
  }

  /**
   * ファイル削除
   * @param fileName ファイル名
   */
  async deleteFile(fileName: string): Promise<void> {
    if (!this.available || !this.rootDirectory) {
      this.log.warn('OPFSが利用できないためdeleteFileをスキップ');
      return;
    }
    
    try {
      await this.rootDirectory.removeEntry(fileName);
      this.log.info(`ファイル削除: ${fileName}`);
    } catch (error) {
      // ファイルが存在しない場合はエラーとしない
      if ((error as any)?.name === 'NotFoundError') {
        this.log.info(`削除対象ファイルが存在しません: ${fileName}`);
        return;
      }
      
      this.log.error(`ファイル削除エラー: ${fileName}`, error);
      throw new FileSystemError(
        'deleteFile', 
        String(error), 
        'ファイルの削除に失敗しました'
      );
    }
  }

  /**
   * 一時ファイルのクリーンアップ
   */
  async cleanupTempFiles(): Promise<void> {
    if (!this.available || !this.rootDirectory) {
      return;
    }
    
    try {
      // 代替方法でディレクトリのエントリを取得
      // TypeScriptの型定義問題を回避するためにasanyを使用
      const entries = this.rootDirectory as any;
      
      // 各エントリを処理
      for await (const [name, handle] of entries) {
        // 一時ファイルのプレフィックスを確認
        if (typeof name === 'string' && 
           (name.startsWith('audio_temp_') || 
            name.startsWith('fusion-recording-') || 
            name.startsWith('fusion-temp-'))) {
          try {
            await this.rootDirectory.removeEntry(name);
            this.log.info(`一時ファイル削除: ${name}`);
          } catch (err) {
            this.log.error(`一時ファイル削除エラー: ${name}`, err);
          }
        }
      }
    } catch (error) {
      this.log.error('一時ファイルクリーンアップエラー:', error);
    }
  }

  /**
   * リソース解放
   */
  async dispose(): Promise<void> {
    if (!this.available) {
      return;
    }
    
    try {
      await this.cleanupTempFiles();
      this.rootDirectory = null;
      this.log.info('OPFSリソース解放完了');
    } catch (error) {
      this.log.error('OPFS解放エラー:', error);
    }
  }

  /**
   * OPFS利用可能性チェック
   * @returns 利用可能な場合はtrue
   */
  private checkAvailability(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'storage' in navigator &&
      'getDirectory' in navigator.storage
    );
  }
}