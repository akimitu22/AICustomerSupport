/**
 * storage.ts
 * バッファ管理と永続化ストレージのインターフェース
 */
import { CapabilitiesResult, OPFSManager, BufferManagerOptions } from './types';

/**
 * 録音データのバッファ管理クラス
 */
export class BufferManager {
  private buffers: Float32Array[] = [];
  private sampleRate: number;
  private maxSamples: number;
  private capabilities: CapabilitiesResult;
  private opfsManager: OPFSManager | null;
  private tempFileName: string;
  private totalSamples: number = 0;
  private isUsingOPFS: boolean = false;

  constructor(options: BufferManagerOptions) {
    this.sampleRate = options.sampleRate;
    this.maxSamples = options.maxSamples || this.sampleRate * 300; // デフォルトは5分
    this.capabilities = options.capabilities;
    this.tempFileName = `audio_temp_${Date.now()}.bin`;

    // OPFSManagerは外部から実装クラスが注入される想定（AudioSystem.tsで処理）
    this.opfsManager = null;
    this.isUsingOPFS = false; // 初期状態では無効、initialize()で実際のマネージャが設定される
  }

  /**
   * バッファマネージャの初期化
   * 外部からOPFSManagerを設定する
   */
  async initialize(opfsManager?: OPFSManager): Promise<void> {
    if (opfsManager) {
      this.opfsManager = opfsManager;
      this.isUsingOPFS = this.capabilities.hasOPFS && !!this.opfsManager;

      if (this.isUsingOPFS && this.opfsManager) {
        await this.opfsManager.initialize();
      }
    }
  }

  /**
   * 録音データをバッファに追加
   */
  async addBuffer(buffer: Float32Array): Promise<void> {
    if (this.totalSamples + buffer.length > this.maxSamples) {
      throw new Error('Buffer overflow: Maximum sample limit exceeded');
    }

    if (this.isUsingOPFS && this.opfsManager) {
      // ArrayBufferLikeをArrayBufferに変換
      const arrayBuffer =
        buffer.buffer instanceof ArrayBuffer
          ? buffer.buffer
          : new ArrayBuffer(buffer.buffer.byteLength);
      if (!(buffer.buffer instanceof ArrayBuffer)) {
        new Uint8Array(arrayBuffer).set(new Uint8Array(buffer.buffer));
      }
      await this.opfsManager.appendToFile(arrayBuffer, this.tempFileName);
    } else {
      this.buffers.push(new Float32Array(buffer));
    }
    this.totalSamples += buffer.length;
  }

  /**
   * 全バッファデータを連結して取得
   */
  async getAllBuffers(): Promise<Float32Array> {
    if (this.totalSamples === 0) {
      return new Float32Array(0);
    }

    if (this.isUsingOPFS && this.opfsManager) {
      const arrayBuffer = await this.opfsManager.readFile(this.tempFileName);
      return new Float32Array(arrayBuffer);
    } else {
      const merged = new Float32Array(this.totalSamples);
      let offset = 0;
      for (const buffer of this.buffers) {
        merged.set(buffer, offset);
        offset += buffer.length;
      }
      return merged;
    }
  }

  /**
   * バッファをリセット
   */
  async reset(): Promise<void> {
    this.buffers = [];
    this.totalSamples = 0;
    if (this.isUsingOPFS && this.opfsManager) {
      try {
        await this.opfsManager.deleteFile(this.tempFileName);
      } catch (error) {
        // ファイルが存在しない場合などは無視
        console.warn('Buffer reset: File deletion error', error);
      }
    }
  }

  /**
   * リソース解放
   */
  async dispose(): Promise<void> {
    await this.reset();
    if (this.isUsingOPFS && this.opfsManager) {
      await this.opfsManager.dispose();
    }
  }

  /**
   * データをファイルに保存
   */
  async saveToFile(merged: Float32Array): Promise<void> {
    if (this.isUsingOPFS && this.opfsManager) {
      // ArrayBufferLikeをArrayBufferに変換
      const arrayBuffer =
        merged.buffer instanceof ArrayBuffer
          ? merged.buffer
          : new ArrayBuffer(merged.buffer.byteLength);
      if (!(merged.buffer instanceof ArrayBuffer)) {
        new Uint8Array(arrayBuffer).set(new Uint8Array(merged.buffer));
      }
      await this.opfsManager.saveFile(arrayBuffer, this.tempFileName);
    }
  }

  /**
   * 合計サンプル数を取得
   */
  getTotalSamples(): number {
    return this.totalSamples;
  }
}