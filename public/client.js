/* ─────────────────────────────────────
   client.js  ―  音声録音・GPT連携・TTS再生
   ───────────────────────────────────── */

// デバッグヘルパー関数（エラー修正版）
const safeLog = (label, data) => {
  try {
    // コンソールが利用可能か確認
    if (typeof console === 'undefined' || !console.log) return;

    // undefined/nullの安全な表示
    if (data === undefined) {
      console.log(`${label}: undefined`);
      return;
    }

    if (data === null) {
      console.log(`${label}: null`);
      return;
    }

    // 大きなデータは省略処理
    if (typeof data === 'string' && data.length > 500) {
      console.log(`${label}:`, data.substring(0, 500) + `... [省略:${data.length - 500}文字]`);
      return;
    }

    // 通常のログ出力
    console.log(`${label}:`, data);
  } catch (e) {
    // ログ出力自体が失敗した場合のフォールバック
    try {
      console.error(`ログ出力エラー(${label}):`, e);
    } catch {
      // 何もできない場合は黙って続行
    }
  }
};

const statusEl = document.getElementById('status');
const recogEl = document.getElementById('recognized');
const replyEl = document.getElementById('reply');
const quickLinksEl = document.getElementById('quick-links');

let audioCtx, processor, micStream, mediaRecorder;
let vadActive = false,
  speaking = false,
  silenceTimer;
let recordingChunks = [];
let isPlayingAudio = false;
let recordingStartTime = 0;
let currentSessionId = localStorage.getItem('kindergarten_session_id') || '';
let conversationStage = 'initial';
window.currentAudio = null; // グローバル変数
let userInteractionPromise = null; // ユーザーインタラクション保存用
let audioInteractionCount = 0; // 追加: インタラクションカウンタ
let audioContext = null; // 追加: グローバルオーディオコンテキスト

// iOS/Safari検出
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const needsSpecialHandling = isIOS || isSafari;

// 追加: ページ全体のタッチイベントを監視
if (needsSpecialHandling) {
  document.addEventListener('touchstart', function() {
    // タッチごとにインタラクションを更新
    storeUserInteraction();
  }, { passive: true });
  
  // クリックイベントも監視
  document.addEventListener('click', function() {
    storeUserInteraction();
  }, { passive: true });
}

// オーディオコンテキストの初期化と解放関数
function initAudioContext() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      safeLog('AudioContext初期化', { state: audioContext.state });
      
      // iOS/Safariの場合は状態確認
      if (needsSpecialHandling && audioContext.state === 'suspended') {
        safeLog('AudioContext停止中 - 再開試行', null);
        audioContext.resume().then(() => {
          safeLog('AudioContext再開成功', { state: audioContext.state });
        }).catch(err => {
          safeLog('AudioContext再開失敗', err);
        });
      }
    } catch (e) {
      safeLog('AudioContext初期化エラー', e);
    }
  }
  return audioContext;
}

// ボタンクリックイベントのユーザーインタラクション保存
document.addEventListener('DOMContentLoaded', function() {
  // 音声サポートトグルボタンの取得
  const toggleButton = document.getElementById('voice-support-toggle');
  
  if (toggleButton) {
    // 既存のクリックイベントを保持するためにイベントリスナーを追加
    toggleButton.addEventListener('click', function() {
      // ユーザーインタラクションを保存
      storeUserInteraction(true); // 重要なインタラクションとしてマーク
    }, { capture: true }); // capture:trueで他のハンドラより先に実行
  }
  
  // クイックリンクのボタンにもユーザーインタラクションを保存
  if (quickLinksEl) {
    quickLinksEl.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON') {
        storeUserInteraction(true);
      }
    }, { capture: true });
  }
  
  // AudioContextの初期化
  initAudioContext();
});

// ユーザーインタラクションを保存する関数
function storeUserInteraction(isImportant = false) {
  try {
    safeLog('ユーザーインタラクション保存開始', { isImportant, count: audioInteractionCount });
    audioInteractionCount++; // インタラクションカウンタを増加
    
    // AudioContextの解放
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().then(() => {
        safeLog('AudioContext再開成功（インタラクション）', { state: audioContext.state });
      }).catch(err => {
        safeLog('AudioContext再開失敗', err);
      });
    }
    
    // iOS/Safariの場合のみ特別な処理を行う
    if (needsSpecialHandling || isImportant) {
      // 無音の短いオーディオファイル
      const silentAudio = new Audio();
      silentAudio.preload = 'auto';
      silentAudio.volume = 0.1; // 小さな音量に設定
      silentAudio.muted = false; // ミュートにしない（iOSでは効果なし）
      silentAudio.src = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAXAAAARW5jb2RlZCBieQBMYXZmNTguMTIuMTAwAEFQSUMAAAEABEVuY29kZWQgYnkATGF2ZjU4LjEyLjEwMAAAAAAAAAAAAABJbmZvAAAADwAAAAgAAABCADwAFAAdACUALQA2AD4ARgBPAFcAYABoAHEAeQCBAIoAkgCbAKMArAC0AL0AxgDOANcA3wDoAPEA+QECAQoBEwEbASQBLAE1AT0BRgFOAVcBXwFoAXABeQGBAYoA//////////////////////////////////////////////////////////////////9MVFJEM0A9V0NPQgAAAC8gY3JlYXRlZCBieSBMYXZmNTguMTIuMTAwAABJRDMEAAAAAAE1TEVOVAAAAA8AAABUaXRsZQBTaWxlbmNlAAA=';
      
      // 無音ファイルの読み込みが完了したときの処理
      silentAudio.oncanplaythrough = function() {
        // ユーザーインタラクションを利用して音声再生
        const promise = silentAudio.play();
        
        if (promise !== undefined) {
          promise.then(() => {
            safeLog('サイレントオーディオ再生成功', null);
            userInteractionPromise = Promise.resolve(true);
          }).catch(err => {
            safeLog('サイレントオーディオ再生エラー', err);
            // エラーでも続行（ユーザー操作がなかった可能性）
            if (isImportant) {
              // 重要なインタラクションは有効とする
              userInteractionPromise = Promise.resolve(true);
            }
          });
        } else {
          // 古いブラウザでの互換性
          safeLog('古いブラウザ対応: play()はPromiseを返さない', null);
          userInteractionPromise = Promise.resolve(true);
        }
      };
      
      // エラー処理
      silentAudio.onerror = function(e) {
        safeLog('サイレントオーディオ読み込みエラー', e);
        // 重要なインタラクションは有効とする
        if (isImportant) {
          userInteractionPromise = Promise.resolve(true);
        }
      };
      
      // タイムアウト処理
      setTimeout(() => {
        if (!userInteractionPromise) {
          safeLog('サイレントオーディオタイムアウト', null);
          if (isImportant) {
            userInteractionPromise = Promise.resolve(true);
          }
        }
      }, 1000);
      
      // 読み込み開始
      try {
        silentAudio.load();
      } catch (e) {
        safeLog('サイレントオーディオ読み込み例外', e);
        // 重要なインタラクションは有効とする
        if (isImportant) {
          userInteractionPromise = Promise.resolve(true);
        }
      }
    } else {
      // iOS/Safari以外の場合は単純に解決済みPromiseを設定
      userInteractionPromise = Promise.resolve(true);
      safeLog('非iOS環境: ユーザーインタラクション保存なし', null);
    }
  } catch (e) {
    safeLog('ユーザーインタラクション保存エラー', e);
    // エラーが発生してもPromiseは有効にする
    userInteractionPromise = Promise.resolve(true);
  }
}

/* ───────── VAD 初期化 ───────── */
startVAD().catch(err => {
  console.error(err);
  statusEl.textContent = '❌ マイク使用不可';
});

async function startVAD() {
  statusEl.textContent = '🎤 マイク準備中…';
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    const gain = audioCtx.createGain();
    gain.gain.value = 1.5;
    processor = audioCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = vadMonitor;
    src.connect(gain);
    gain.connect(processor);
    processor.connect(audioCtx.destination);

    // iOS Safariはwebmをサポートしない → fallback & 警告
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/mp4';
    mediaRecorder = new MediaRecorder(micStream, { mimeType });

    // iOS警告（条件を満たした場合のみ表示）
    if (
      !MediaRecorder.isTypeSupported('audio/webm;codecs=opus') &&
      /iP(hone|ad|od)/.test(navigator.userAgent)
    ) {
      alert(
        '⚠️ お使いのブラウザ（iOS Safariなど）は録音に対応していません。Chrome または Android を推奨します。'
      );
    }

    mediaRecorder.ondataavailable = e => recordingChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingStop;

    statusEl.textContent = '🎧 どうぞお話しください…';
    vadActive = true;
    createQuickLinks();
    
    // 初回のユーザーインタラクションを保存
    storeUserInteraction(true);
    
    // iOSの場合はオーディオコンテキストの状態を確認
    if (needsSpecialHandling && audioCtx && audioCtx.state === 'suspended') {
      try {
        await audioCtx.resume();
        safeLog('AudioContext初期化時に再開', { state: audioCtx.state });
      } catch (err) {
        safeLog('AudioContext初期再開エラー', err);
      }
    }
  } catch (err) {
    console.error('マイク初期化エラー:', err);
    throw err;
  }
}

/* ───────── 発話検知 ───────── */
function vadMonitor(e) {
  if (!vadActive || isPlayingAudio) return;
  const buf = e.inputBuffer.getChannelData(0);
  const vol = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
  if (vol > 0.015) {
    if (!speaking) {
      speaking = true;
      statusEl.textContent = '📢 発話中…';
      recordingChunks = [];
      recordingStartTime = Date.now();
      mediaRecorder.start();
      
      // 発話開始時にユーザーインタラクションを更新
      storeUserInteraction(true);
    }
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stopRecording, 1500); // 1.5秒に延長
  }
}

function stopRecording() {
  if (mediaRecorder.state === 'recording') mediaRecorder.stop();
  speaking = false;
  vadActive = false;
  statusEl.textContent = '🧠 回答中…';
}

/* ───────── 修正: Whisper → GPT → TTS ───────── */
async function handleRecordingStop() {
  const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType });

  safeLog('録音Blobサイズ', blob.size);

  // 録音時間をチェック - 短すぎる場合は処理しない
  const duration = (Date.now() - recordingStartTime) / 1000;
  if (duration < 1.5) {
    statusEl.textContent = '❌ 発話が短すぎます。もう少し長く話してください。';
    vadActive = true;
    return;
  }

  try {
    statusEl.textContent = '🧠 発話認識中…';

    // Base64エンコード処理
    const arrayBuffer = await blob.arrayBuffer();
    const base64Data = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    safeLog('音声データサイズ', Math.round(base64Data.length / 1024) + 'KB');
    safeLog('録音時間', duration + '秒');

    // STTリクエスト送信
    safeLog('STTリクエスト送信開始', {
      endpoint: '/.netlify/functions/stt',
      format: mediaRecorder.mimeType,
      duration: duration,
    });

    // STTリクエスト送信 (エラーハンドリング強化)
    let response;
    try {
      response = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio: base64Data,
          format: mediaRecorder.mimeType,
          duration: duration,
        }),
      });

      safeLog('STTレスポンス受信', {
        status: response.status,
        statusText: response.statusText,
      });

      if (!response.ok) {
        if (response.status === 422) {
          throw new Error('音声を認識できませんでした。もう少しはっきり話してください。');
        } else {
          throw new Error(`STTサーバーエラー: ${response.status} ${response.statusText}`);
        }
      }

      // レスポンスのJSONパース (エラーハンドリング強化)
      let sttResult;
      try {
        sttResult = await response.json();
        safeLog('STT結果(生データ)', sttResult);
      } catch (jsonError) {
        safeLog('JSONパースエラー', jsonError);
        throw new Error(`STTレスポンスのJSONパースに失敗: ${jsonError.message}`);
      }

      // データ構造の堅牢な検証
      if (!sttResult) {
        throw new Error('STTレスポンスが空です');
      }

      // エラーチェック
      if (sttResult.error) {
        safeLog('STTエラーレスポンス', sttResult.error);
        throw new Error(`音声認識エラー: ${sttResult.error}`);
      }

      // text プロパティの検証 (堅牢性向上)
      let recognizedText;

      // ケース1: 新しい構造 - { text: "...", originalText: "...", success: true }
      if (sttResult.text && typeof sttResult.text === 'string' && sttResult.text.trim()) {
        recognizedText = sttResult.text;
        safeLog('認識テキスト(直接プロパティ)', recognizedText);
      }
      // ケース2: 古い構造 - { stt: { text: "..." }, ... }
      else if (
        sttResult.stt &&
        sttResult.stt.text &&
        typeof sttResult.stt.text === 'string' &&
        sttResult.stt.text.trim()
      ) {
        recognizedText = sttResult.stt.text;
        safeLog('認識テキスト(sttプロパティ経由)', recognizedText);
      }
      // ケース3: その他の構造 または 空テキスト - エラー
      else {
        safeLog('無効なSTTレスポンス構造', {
          hasText: !!sttResult.text,
          textType: typeof sttResult.text,
          textEmpty: sttResult.text === '',
          hasStt: !!sttResult.stt,
          sttType: typeof sttResult.stt,
          allKeys: Object.keys(sttResult),
        });
        throw new Error('STTレスポンスに有効なテキストが含まれていません');
      }

      // テキスト処理と表示
      let fixedText = recognizedText.replace(
        /ご視聴ありがとうございました/g,
        'ご回答ありがとうございました'
      );
      recogEl.textContent = `お問合せ内容: ${fixedText}`;

      // AIへの処理を開始
      await handleAI(recognizedText);
    } catch (e) {
      safeLog('STT処理エラー', e);
      statusEl.textContent = '❌ 発話認識失敗: ' + (e.message || '不明なエラー');
      vadActive = true;
    }
  } catch (outerError) {
    safeLog('音声認識全体エラー', outerError);
    statusEl.textContent = '❌ 発話認識失敗';
    vadActive = true;
  }
}

async function handleAI(msg) {
  try {
    statusEl.textContent = '💭 回答生成中…';

    // 中間メッセージを表示
    showInterimMessage('しばらくお待ちください。');

    safeLog('AIリクエスト送信開始', {
      message: msg.substring(0, 50) + (msg.length > 50 ? '...' : ''),
    });

    // 事前にオーディオシステムをウォームアップ (追加)
    if (needsSpecialHandling) {
      try {
        // 新しいAudioContextでウォームアップ
        const tempContext = new (window.AudioContext || window.webkitAudioContext)();
        await tempContext.resume();
        
        // 音声ファイルの先読み
        const warmupAudio = new Audio();
        warmupAudio.preload = 'auto';
        warmupAudio.src = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAXAAAARW5jb2RlZCBieQBMYXZmNTguMTIuMTAwAEFQSUMAAAEABEVuY29kZWQgYnkATGF2ZjU4LjEyLjEwMAAAAAAAAAAAAABJbmZvAAAADwAAAAgAAABCADwAFAAdACUALQA2AD4ARgBPAFcAYABoAHEAeQCBAIoAkgCbAKMArAC0AL0AxgDOANcA3wDoAPEA+QECAQoBEwEbASQBLAE1AT0BRgFOAVcBXwFoAXABeQGBAYoA//////////////////////////////////////////////////////////////////9MVFJEM0A9V0NPQgAAAC8gY3JlYXRlZCBieSBMYXZmNTguMTIuMTAwAABJRDMEAAAAAAE1TEVOVAAAAA8AAABUaXRsZQBTaWxlbmNlAAA=';
        warmupAudio.load();
        
        safeLog('オーディオシステムウォームアップ完了', null);
        
        // クリーンアップ（少し待ってからクローズ）
        setTimeout(() => {
          try {
            tempContext.close();
          } catch (e) {
            // エラーは無視
          }
        }, 1000);
      } catch (e) {
        safeLog('オーディオウォームアップエラー', e);
        // エラーは無視して続行
      }
    }

    // AIリクエスト (エラーハンドリング強化)
    let aiResponse;
    try {
      const response = await fetch('/.netlify/functions/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, sessionId: currentSessionId }),
      });

      safeLog('AIレスポンス受信', { status: response.status });

      if (!response.ok) {
        throw new Error(`AIサーバーエラー: ${response.status}`);
      }

      aiResponse = await response.json();
    } catch (aiError) {
      safeLog('AI通信エラー', aiError);
      throw new Error(`AI処理中にエラーが発生: ${aiError.message}`);
    }

    safeLog('AI結果', {
      hasReply: !!aiResponse.reply,
      sessionId: aiResponse.sessionId,
      stage: aiResponse.stage,
    });

    // レスポンス検証
    if (!aiResponse || !aiResponse.reply) {
      throw new Error('AIからの応答が無効です');
    }

    // セッション情報の更新
    currentSessionId = aiResponse.sessionId || currentSessionId;
    localStorage.setItem('kindergarten_session_id', currentSessionId);
    conversationStage = aiResponse.stage || conversationStage;

    // 中間メッセージを非表示
    hideInterimMessage();

    // 回答テキストを表示
    setTimeout(() => {
      replyEl.textContent = `サポートからの回答: ${aiResponse.reply}`;
    }, 500);

    // TTS処理開始
    statusEl.textContent = '🔊 回答生成中…';

    safeLog('TTSリクエスト送信開始', {
      textLength: aiResponse.reply.length,
      textPreview: aiResponse.reply.substring(0, 50) + (aiResponse.reply.length > 50 ? '...' : ''),
    });

    // TTSリクエスト (エラーハンドリング強化)
    let ttsResponse;
    try {
      const response = await fetch('/.netlify/functions/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: aiResponse.reply }),
      });

      safeLog('TTSレスポンス受信', { status: response.status });

      if (!response.ok) {
        throw new Error(`TTSサーバーエラー: ${response.status}`);
      }

      ttsResponse = await response.json();
    } catch (ttsError) {
      safeLog('TTS通信エラー', ttsError);
      throw new Error(`TTS処理中にエラーが発生: ${ttsError.message}`);
    }

    safeLog('TTS結果', {
      hasAudioUrl: !!ttsResponse.audioUrl,
      hasError: !!ttsResponse.error,
    });

    // 音声URL検証と再生
    if (ttsResponse.audioUrl) {
      safeLog('音声URL取得成功', { urlPreview: ttsResponse.audioUrl.substring(0, 50) + '...' });

      try {
        // iOS/Safariでユーザーインタラクションが不確かな場合は再確認
        if (needsSpecialHandling && (!userInteractionPromise || audioInteractionCount < 2)) {
          // 再生ボタンを表示するフォールバック
          showPlayButton(ttsResponse.audioUrl);
          safeLog('インタラクション不足のため再生ボタンを表示', { count: audioInteractionCount });
        } else {
          // 通常の音声再生
          await playAudio(ttsResponse.audioUrl);
          safeLog('音声再生完了', '再生完了');
        }
      } catch (playError) {
        safeLog('音声再生エラー', playError);
        // 再生エラーの場合はボタンを表示
        showPlayButton(ttsResponse.audioUrl);
      }
    } else if (ttsResponse.error) {
      safeLog('TTS エラー', {
        error: ttsResponse.error,
        detail: ttsResponse.errorDetail || '',
      });
      // エラーがあってもテキスト応答は表示済みなので続行
    } else {
      safeLog('音声URLが見つかりません', ttsResponse);
      // 音声なしでも続行
    }
  } catch (e) {
    safeLog('AI/TTS処理エラー', e);
    statusEl.textContent = '❌ 回答生成失敗: ' + (e.message || '不明なエラー');
    hideInterimMessage();
  } finally {
    // 最終状態を更新
    vadActive = true;
    statusEl.textContent = '🎧 次の発話を検知します';
  }
}

/* ───────── 中間メッセージ関連 ───────── */
// 中間メッセージを表示する関数
function showInterimMessage(text) {
  let interimEl = document.getElementById('interim-message');
  if (!interimEl) {
    interimEl = document.createElement('div');
    interimEl.id = 'interim-message';
    interimEl.className = 'message ai-message interim';
    replyEl.parentNode.insertBefore(interimEl, replyEl);
  }
  interimEl.textContent = text;
  interimEl.style.display = 'block';
}

// 中間メッセージを非表示にする関数
function hideInterimMessage() {
  const interimEl = document.getElementById('interim-message');
  if (interimEl) interimEl.style.display = 'none';
}

/* ───────── 音声再生 ───────── */
function playAudio(url) {
  return new Promise((resolve, reject) => {
    try {
      safeLog('音声再生開始処理', { url: url.slice(0, 60) + '…' });

      /* 既存音声を完全停止 */
      if (isPlayingAudio && window.currentAudio) {
        try {
          window.currentAudio.pause();
        } catch {}
        window.currentAudio.src = '';
        window.currentAudio = null;
        isPlayingAudio = false;
      }

      // 再生前にユーザーインタラクションの確認（追加）
      const ensureInteraction = async () => {
        if (!userInteractionPromise || (needsSpecialHandling && audioInteractionCount < 2)) {
          safeLog('再生前にインタラクション再確認', { count: audioInteractionCount });
          
          // 自動再生が許可されているか簡易テスト
          let isAutoplayAllowed = false;
          try {
            const testAudio = new Audio();
            testAudio.volume = 0.01; // ごく小さな音量
testAudio.src = 'data:audio/mp3;base64,SUQzBAAAAAABEVRYWFgAAAAXAAAARW5jb2RlZCBieQBMYXZmNTguMTIuMTAwAEFQSUMAAAEABEVuY29kZWQgYnkATGF2ZjU4LjEyLjEwMAAAAAAAAAAAAABJbmZvAAAADwAAAAgAAABCADwAFAAdACUALQA2AD4ARgBPAFcAYABoAHEAeQCBAIoAkgCbAKMArAC0AL0AxgDOANcA3wDoAPEA+QECAQoBEwEbASQBLAE1AT0BRgFOAVcBXwFoAXABeQGBAYoA//////////////////////////////////////////////////////////////////9MVFJEM0A9V0NPQgAAAC8gY3JlYXRlZCBieSBMYXZmNTguMTIuMTAwAABJRDMEAAAAAAE1TEVOVAAAAA8AAABUaXRsZQBTaWxlbmNlAAA=';
            await testAudio.play().then(() => {
              isAutoplayAllowed = true;
              testAudio.pause();
            }).catch(() => {
              isAutoplayAllowed = false;
            });
          } catch (e) {
            isAutoplayAllowed = false;
          }
          
          if (!isAutoplayAllowed) {
            // インタラクションを保存して再試行
            await storeUserInteraction(true);
          }
        }
      };

      // ユーザーインタラクションを利用して音声再生
      const playWithInteraction = async () => {
        // インタラクション確認
        await ensureInteraction();
        
        /* 新しい Audio インスタンス */
        window.currentAudio = new Audio();
        let lastPos = 0;
        let idleCount = 0;
        const MAX_IDLE = 6; // ← ★ idle 緩和 6-8 回
        const IDLE_TH = 0.1; // ← ★ Δ < 0.1 s で idle 加算
        const RESET_TH = 0.5; // ← ★ Δ ≥ 0.5 s で idle リセット
        let progressTimer = null;
        let backupTimer = null;

        /* 進捗監視 */
        const startWatch = () => {
          progressTimer = setInterval(() => {
            if (!isPlayingAudio) return;

            const cur = window.currentAudio.currentTime;
            const delta = cur - lastPos;

            if (delta < IDLE_TH) {
              idleCount++;
              if (idleCount >= MAX_IDLE) {
                safeLog('無音停止検出', { cur, idleCount });
                cleanup(); // 停止処理
              }
            } else if (delta >= RESET_TH) {
              idleCount = 0; // 大きく進んだらカウンタ初期化
            }
            lastPos = cur;
          }, 1000);
        };

        /* 停止共通処理 */
        const cleanup = () => {
          try {
            window.currentAudio.pause();
          } catch {}
          clearInterval(progressTimer);
          clearTimeout(backupTimer);
          isPlayingAudio = false;
          resolve();
        };

        /* エラー処理 */
        window.currentAudio.onerror = e => {
          clearInterval(progressTimer);
          clearTimeout(backupTimer);
          isPlayingAudio = false;
          reject(new Error('音声読み込み失敗'));
        };

        /* 再生準備完了 → 動的タイマー確定 */
        window.currentAudio.oncanplaythrough = () => {
          safeLog('音声 oncanplaythrough', { duration: window.currentAudio.duration });

          /* 動的バックアップ: (音声長 +10 s) ただし最大90 s */
          const dur =
            isFinite(window.currentAudio.duration) && window.currentAudio.duration > 0
              ? Math.min(90, window.currentAudio.duration + 10)
              : 90;

          backupTimer = setTimeout(() => {
            safeLog('バックアップタイマー発火', { dur });
            cleanup();
          }, dur * 1000);

          /* 再生開始 */
          isPlayingAudio = true;
          
          // iOS/Safariの場合は特別な処理
          if (needsSpecialHandling) {
            // AudioContextをウェイクアップ
            if (audioContext && audioContext.state === 'suspended') {
              audioContext.resume().catch(() => {});
            }
            
            // iOSの場合、タッチイベントからの時間が経っていると失敗する可能性が高い
            // 再生ボタンを表示する前に最後の試行として再生を試みる
            window.currentAudio.play().then(() => {
              safeLog('iOS音声再生開始成功', null);
              startWatch(); // 進捗監視開始
            }).catch(err => {
              safeLog('iOS音声再生失敗 - フォールバック', err);
              // フォールバック: 再生ボタンを表示
              cleanup();
              showPlayButton(url);
              reject(new Error('iOS自動再生失敗'));
            });
          } else {
            // 通常の環境では標準の再生
            window.currentAudio.play()
              .then(() => {
                safeLog('音声再生開始');
                startWatch(); // 進捗監視開始
              })
              .catch(err => {
                safeLog('音声再生エラー', err);
                cleanup();
                
                // 再生失敗時は2回まで再試行
                if (!window.playAttempts) window.playAttempts = 0;
                window.playAttempts++;
                
                if (window.playAttempts <= 2) {
                  safeLog('音声再生リトライ', { attempt: window.playAttempts });
                  // 少し待ってから再試行
                  setTimeout(() => {
                    playAudio(url).then(resolve).catch(() => {
                      // 最終的な失敗: ボタンを表示
                      showPlayButton(url);
                      reject(err);
                    });
                  }, 500);
                } else {
                  // 再試行回数超過: ボタンを表示
                  showPlayButton(url);
                  window.playAttempts = 0;
                  reject(err);
                }
              });
          }
        };

        /* 再生正常終了 */
        window.currentAudio.onended = () => {
          safeLog('音声再生 onended');
          cleanup();
          // 再試行カウンタリセット
          window.playAttempts = 0;
        };

        /* URL 設定してロード */
        window.currentAudio.preload = 'auto'; // プリロード設定
        window.currentAudio.src = url;
        
        // iOS/Safariの場合はさらに設定を追加
        if (needsSpecialHandling) {
          // iOS Safariでの信頼性向上のための追加設定
          window.currentAudio.autoplay = false; // autoplayは明示的に無効化
          window.currentAudio.controls = false; // コントロールは表示しない
          window.currentAudio.crossOrigin = 'anonymous'; // CORS設定
        }
        
        window.currentAudio.load();
      };
      
      // ページ・DOMとの相互作用を確実にするため、少し遅延させる
      setTimeout(async () => {
        try {
          await playWithInteraction();
        } catch (err) {
          safeLog('playWithInteraction失敗', err);
          // 失敗時もrejectしない（showPlayButtonがフォールバックとして表示されるため）
          resolve();
        }
      }, 100);
      
    } catch (err) {
      safeLog('playAudio全体エラー', err);
      isPlayingAudio = false;
      
      // エラー時はボタンを表示してresolve
      showPlayButton(url);
      resolve(); // rejectではなくresolveで続行（フォールバックあり）
    }
  });
}

// フォールバック: 再生ボタンを表示
function showPlayButton(url) {
  safeLog('再生ボタン表示', null);
  // 既存の再生ボタンを確認
  const existingButton = document.querySelector('.audio-play-btn');
  if (existingButton) {
    safeLog('既存の再生ボタンがあるため新規作成をスキップ', null);
    return;
  }
  
  const playButton = document.createElement('button');
  playButton.textContent = '🔊 回答を聞く';
  playButton.className = 'action-btn audio-play-btn';
  playButton.style.backgroundColor = '#4a8ab8';
  playButton.style.marginTop = '10px';
  playButton.style.padding = '10px 20px';
  playButton.style.fontSize = '16px';
  playButton.style.borderRadius = '8px';
  playButton.style.border = 'none';
  playButton.style.cursor = 'pointer';
  playButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
  
  // タップ操作を最適化
  if (needsSpecialHandling) {
    playButton.style.padding = '12px 24px'; // より大きなタップエリア
  }
  
  playButton.onclick = () => {
    // クリック時にオーディオを再生
    playButton.disabled = true;
    playButton.textContent = '▶ 再生中...';
    playButton.style.backgroundColor = '#999';
    
    // インタラクションをリフレッシュ
    storeUserInteraction(true);
    
    // 新しいAudioインスタンス
    const audio = new Audio(url);
    audio.volume = 1.0;
    
    // 進捗表示用のバー（オプション）
    const progressBar = document.createElement('div');
    progressBar.style.width = '100%';
    progressBar.style.backgroundColor = '#eee';
    progressBar.style.height = '4px';
    progressBar.style.marginTop = '5px';
    progressBar.style.borderRadius = '2px';
    progressBar.style.overflow = 'hidden';
    
    const progress = document.createElement('div');
    progress.style.width = '0%';
    progress.style.backgroundColor = '#4a8ab8';
    progress.style.height = '100%';
    progressBar.appendChild(progress);
    
    playButton.appendChild(progressBar);
    
    // 進捗更新
    const updateInterval = setInterval(() => {
      if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        progress.style.width = `${percent}%`;
      }
    }, 100);
    
    audio.oncanplaythrough = () => {
      audio.play().then(() => {
        safeLog('ボタンからの再生開始', null);
      }).catch(err => {
        safeLog('ボタンからの再生エラー', err);
        playButton.textContent = '❌ 再生失敗';
        playButton.disabled = false;
        clearInterval(updateInterval);
      });
    };
    
    audio.onended = () => {
      playButton.remove();
      clearInterval(updateInterval);
    };
    
    audio.onerror = () => {
      playButton.textContent = '❌ 再生失敗';
      playButton.disabled = false;
      clearInterval(updateInterval);
    };
    
    // クリックイベントをユーザーインタラクションとして保存
    storeUserInteraction(true);
  };
  
  // ボタンを追加
  if (replyEl) {
    const existingButton = replyEl.querySelector('.action-btn');
    if (existingButton) {
      existingButton.remove();
    }
    replyEl.appendChild(playButton);
  }
}

/* ───────── クイックリンク & UI ───────── */
function createQuickLinks() {
  const arr = [
    '幼稚園の基本情報を教えてください',
    '入園の申し込みについて教えてください',
    '給食について教えてください',
    '保育時間について教えてください',
    '見学できますか？',
  ];
  quickLinksEl.innerHTML = '';
  arr.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t;
    b.className = 'ql';
    b.onclick = () => {
      recogEl.textContent = `お問合せ内容: ${t}`;
      handleAI(t);
      // クリックイベントをユーザーインタラクションとして保存
      storeUserInteraction(true);
    };
    quickLinksEl.appendChild(b);
  });
}