import { Logger } from "Logger";

// AudioBlobManager.ts
export class AudioBlobManager {
  private chunks: Blob[] = [];
  private mimeType: string;
  private log: Logger;
  
  constructor(mimeType: string = 'audio/mp4', debug: boolean = false) {
    this.mimeType = mimeType;
    this.log = new Logger(debug);
  }
  
  /**
   * Blobチャンクを追加
   */
  addChunk(blob: Blob): void {
    this.chunks.push(blob);
    this.log.info(`Blobチャンク追加: ${blob.size} bytes, 合計: ${this.chunks.length} チャンク`);
  }
  
  /**
   * すべてのチャンクを結合して単一のBlobを取得
   */
  getBlob(): Blob {
    if (this.chunks.length === 0) {
      return new Blob([], { type: this.mimeType });
    }
    
    if (this.chunks.length === 1) {
      return this.chunks[0];
    }
    
    return new Blob(this.chunks, { type: this.mimeType });
  }
  
  /**
   * 再生可能なMediaSourceURLを作成（ストリーミング再生用）
   */
  async createMediaSourceUrl(): Promise<string> {
    if (this.chunks.length === 0) {
      return '';
    }
    
    // 単一のBlobなら直接URL作成
    if (this.chunks.length === 1) {
      return URL.createObjectURL(this.chunks[0]);
    }
    
    // 複数チャンクをMediaSourceで再生（iOS 15+対応）
    try {
      const mediaSource = new MediaSource();
      const url = URL.createObjectURL(mediaSource);
      
      return new Promise((resolve, reject) => {
        mediaSource.addEventListener('sourceopen', async () => {
          try {
            const mimeCodec = this.getMimeCodec();
            const sourceBuffer = mediaSource.addSourceBuffer(mimeCodec);
            
            // 順次チャンクを追加
            for (const chunk of this.chunks) {
              const arrayBuffer = await chunk.arrayBuffer();
              
              // 前のデータ追加が完了するのを待つ
              await new Promise<void>(resolveUpdate => {
                if (sourceBuffer.updating) {
                  sourceBuffer.addEventListener('updateend', () => resolveUpdate(), { once: true });
                } else {
                  resolveUpdate();
                }
              });
              
              sourceBuffer.appendBuffer(arrayBuffer);
            }
            
            // すべてのバッファが追加されたらMediaSourceを終了
            await new Promise<void>(resolveEnd => {
              if (sourceBuffer.updating) {
                sourceBuffer.addEventListener('updateend', () => resolveEnd(), { once: true });
              } else {
                resolveEnd();
              }
            });
            
            mediaSource.endOfStream();
            resolve(url);
          } catch (err) {
            this.log.error('MediaSource処理エラー:', err);
            reject(err);
          }
        }, { once: true });
        
        mediaSource.addEventListener('error', (e) => {
          this.log.error('MediaSourceエラー:', e);
          reject(new Error('MediaSource error'));
        }, { once: true });
      });
    } catch (err) {
      // MediaSourceがサポートされていない場合のフォールバック
      this.log.warn('MediaSourceがサポートされていないか、エラーが発生しました。単一Blobにフォールバック:', err);
      const combined = this.getBlob();
      return URL.createObjectURL(combined);
    }
  }
  
  /**
   * MIMEタイプからメディアコーデックを推定
   */
  private getMimeCodec(): string {
    switch (this.mimeType) {
      case 'audio/mp4':
        return 'audio/mp4; codecs="mp4a.40.2"';
      case 'audio/webm':
        return 'audio/webm; codecs="opus"';
      case 'audio/ogg':
        return 'audio/ogg; codecs="opus"';
      case 'audio/mpeg':
        return 'audio/mpeg';
      default:
        return this.mimeType;
    }
  }
  
  /**
   * すべてのリソースを解放
   */
  dispose(): void {
    this.chunks = [];
    this.log.info('AudioBlobManagerリソース解放完了');
  }
}