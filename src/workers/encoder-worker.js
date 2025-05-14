// Encoder Worker
self.onmessage = function (e) {
  const data = e.data;

  if (data.command === 'encode' && data.buffer) {
    try {
      // 進捗通知
      self.postMessage({ progress: 0.1 });

      // Float32ArrayをInt16に変換
      const pcmBuffer = convertFloat32ToInt16(data.buffer);
      self.postMessage({ progress: 0.5 });

      // WAV形式にエンコード
      const wavBlob = encodeWAV(pcmBuffer, data.sampleRate || 44100);
      self.postMessage({ progress: 0.9 });

      // エンコード結果を返信
      self.postMessage({ wavBlob: wavBlob, progress: 1.0 });
    } catch (error) {
      self.postMessage({ error: error.message || 'エンコード中にエラーが発生しました' });
    }
  }
};

/**
 * Float32ArrayをInt16Arrayに変換
 */
function convertFloat32ToInt16(float32Array) {
  const length = float32Array.length;
  const int16Array = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    // 範囲を-1.0～1.0に制限してからスケーリング
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    // 負の値: -32768～0、正の値: 0～32767
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  return int16Array;
}

/**
 * Int16ArrayをWAVフォーマットのBlobに変換
 */
function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // WAVヘッダー書き込み
  writeString(view, 0, 'RIFF'); // RIFFヘッダー
  view.setUint32(4, 36 + samples.length * 2, true); // ファイルサイズ
  writeString(view, 8, 'WAVE'); // WAVEフォーマット
  writeString(view, 12, 'fmt '); // fmtチャンク
  view.setUint32(16, 16, true); // fmtチャンクサイズ
  view.setUint16(20, 1, true); // フォーマットタイプ(PCM)
  view.setUint16(22, 1, true); // チャネル数(モノラル)
  view.setUint32(24, sampleRate, true); // サンプルレート
  view.setUint32(28, sampleRate * 2, true); // バイトレート (sampleRate * blockAlign)
  view.setUint16(32, 2, true); // ブロックアライン (channels * bitsPerSample/8)
  view.setUint16(34, 16, true); // ビット深度
  writeString(view, 36, 'data'); // dataチャンク
  view.setUint32(40, samples.length * 2, true); // データサイズ

  // サンプルデータの書き込み - constをletに変更
  let offset = 44; // const → let に変更
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, samples[i], true);
    offset += 2; // forループ内で直接増分させずに明示的に処理
  }

  // BLOBとして返却
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * DataViewに文字列を書き込む
 */
function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
