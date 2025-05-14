// VAD (Voice Activity Detection) Worker
let sensitivity = 0.5; // 感度 (0.0 - 1.0)
let silenceTimeout = 800; // 無音タイムアウト（ミリ秒）
let isSpeaking = false; // 発話中フラグ
let speechStart = 0; // 発話開始時刻
let silenceStart = 0; // 無音開始時刻

// メインスレッドからのメッセージハンドラ
self.onmessage = function (e) {
  const data = e.data;

  // 初期化コマンド
  if (data.command === 'init') {
    sensitivity = data.sensitivity !== undefined ? data.sensitivity : sensitivity;
    silenceTimeout = data.silenceTimeout !== undefined ? data.silenceTimeout : silenceTimeout;
    console.log('[VAD Worker] 初期化完了', { sensitivity, silenceTimeout });
    // ワーカーが正しく初期化されたことをメインスレッドに通知
    self.postMessage({ type: 'ping', initialized: true });
    return;
  }

  // 感度設定コマンド
  if (data.command === 'setSensitivity') {
    sensitivity = Math.max(0, Math.min(1, data.sensitivity));
    console.log('[VAD Worker] 感度更新:', sensitivity);
    return;
  }

  // バッファ処理コマンド
  if (data.type === 'process' && data.buffer) {
    processAudioBuffer(data.buffer);
  }
};

/**
 * 音声バッファを処理し、発話を検出
 */
function processAudioBuffer(buffer) {
  try {
    // RMSエネルギーを計算
    const energy = calculateRMS(buffer);

    // 閾値を計算 (0.01 ~ 0.04 の範囲で調整、感度が高いほど閾値は低くなる)
    const threshold = 0.04 - sensitivity * 0.03;

    // エネルギーのデバッグログ（たまに出力）
    if (Math.random() < 0.05) {
      console.log(
        `[VAD Worker] Energy: ${energy.toFixed(6)}, Threshold: ${threshold.toFixed(
          6
        )}, Speaking: ${isSpeaking}`
      );
    }

    // 発話判定
    const now = Date.now();
    const hasSignal = energy > threshold;

    // 発話開始検出
    if (hasSignal && !isSpeaking) {
      isSpeaking = true;
      speechStart = now;

      // メインスレッドに通知
      self.postMessage({
        type: 'vadResult',
        isSpeech: true,
        energy: energy,
        threshold: threshold,
        speechStart: true,
      });

      console.log('[VAD Worker] 発話開始検出', { energy, threshold });
    }
    // 発話中
    else if (isSpeaking) {
      if (hasSignal) {
        // 継続中の発話
        silenceStart = 0;
      } else {
        // 無音検出
        if (silenceStart === 0) {
          silenceStart = now;
          console.log('[VAD Worker] 無音検出開始', { time: now });
        }

        // 無音が一定時間続いたら発話終了と判断
        if (now - silenceStart > silenceTimeout) {
          const speechDuration = (silenceStart - speechStart) / 1000; // 秒単位

          isSpeaking = false;
          silenceStart = 0;

          // メインスレッドに通知
          self.postMessage({
            type: 'vadResult',
            isSpeech: false,
            energy: energy,
            threshold: threshold,
            speechEnd: true,
            speechDuration: speechDuration,
          });

          console.log('[VAD Worker] 発話終了検出', {
            speechDuration,
            silenceTimeout,
            timeSinceSilence: now - silenceStart,
          });
          return;
        }
      }

      // 発話継続中の通知
      self.postMessage({
        type: 'vadResult',
        isSpeech: true,
        energy: energy,
        threshold: threshold,
      });
    } else {
      // 非発話状態の通知（デバッグ用）
      self.postMessage({
        type: 'vadResult',
        isSpeech: false,
        energy: energy,
        threshold: threshold,
      });
    }
  } catch (err) {
    console.error('[VAD Worker] Error:', err);
    // エラー発生時もメインスレッドに通知
    self.postMessage({
      type: 'error',
      message: err.message || 'VAD処理中にエラーが発生しました',
    });
  }
}

/**
 * オーディオバッファからRMS（二乗平均平方根）を計算
 */
function calculateRMS(buffer) {
  let sum = 0;
  const length = buffer.length;

  for (let i = 0; i < length; i++) {
    sum += buffer[i] * buffer[i];
  }

  return Math.sqrt(sum / length);
}
