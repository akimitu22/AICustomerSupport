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
let audioInteractionCount = 0; // インタラクションカウンタ

// iOS/Safari検出
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const needsSpecialHandling = isIOS || isSafari;

// iOS Safariでの音声再生問題を解決するための初期化
if (needsSpecialHandling) {
  document.addEventListener('click', initAudioForIOS);
  document.addEventListener('touchstart', initAudioForIOS);
}

// iOS用オーディオ初期化
function initAudioForIOS() {
  if (!window._audioInitialized) {
    try {
      // AudioContextを初期化
      const tempContext = new (window.AudioContext || window.webkitAudioContext)();
      tempContext.resume().catch(() => {});
      
      // 無音の音声を作成して再生
      const silentSound = tempContext.createOscillator();
      const gainNode = tempContext.createGain();
      gainNode.gain.value = 0; // 無音
      silentSound.connect(gainNode);
      gainNode.connect(tempContext.destination);
      silentSound.start();
      silentSound.stop(tempContext.currentTime + 0.001);
      
      // 初期化フラグを設定
      window._audioInitialized = true;
      safeLog('iOS用オーディオ初期化完了', null);
      
      // イベントリスナーを削除
      document.removeEventListener('click', initAudioForIOS);
      document.removeEventListener('touchstart', initAudioForIOS);
    } catch (e) {
      safeLog('iOS用オーディオ初期化失敗', e);
    }
  }
}

// ユーザーインタラクションの保存
function storeUserInteraction(isImportant = false) {
  safeLog('ユーザーインタラクション保存', { isImportant, count: ++audioInteractionCount });
  
  // iOS/Safari環境での特別処理
  if (needsSpecialHandling) {
    try {
      // AudioContextを初期化して再開
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(() => {});
      
      // 無音の音声を再生してユーザーインタラクションを確立
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0; // 無音
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.001);
      
      safeLog('オーディオコンテキスト初期化', { state: ctx.state });
    } catch (e) {
      safeLog('オーディオコンテキスト初期化エラー', e);
    }
  }
  
  // インタラクションを保存
  userInteractionPromise = Promise.resolve(true);
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
        // 自動再生を試みる
        if (needsSpecialHandling) {
          // iOS/Safariではボタンを直接表示
          showPlayButton(ttsResponse.audioUrl);
          safeLog('iOS/Safari環境のため再生ボタンを表示', null);
        } else {
          // 他の環境では自動再生を試みる
          await playAudio(ttsResponse.audioUrl);
          safeLog('音声再生完了', '再生完了');
        }
      } catch (playError) {
        safeLog('音声再生エラー - ボタン表示へフォールバック', playError);
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
        window.currentAudio
          .play()
          .then(() => safeLog('音声再生開始'))
          .catch(err => {
            safeLog('音声再生エラー', err);
            clearTimeout(backupTimer);
            
            // 再生失敗時はボタンを表示
            showPlayButton(url);
            reject(err);
          });

        startWatch(); // 進捗監視開始
      };

      /* 再生正常終了 */
      window.currentAudio.onended = () => {
        safeLog('音声再生 onended');
        cleanup();
      };

      /* URL 設定してロード */
      window.currentAudio.src = url;
      window.currentAudio.load();
    } catch (err) {
      isPlayingAudio = false;
      reject(err);
    }
  });
}

// フォールバック: 再生ボタンを表示
function showPlayButton(url) {
  safeLog('再生ボタン表示', { url: url.slice(0, 60) + '...' });
  // 既存の再生ボタンを確認
  const existingButton = document.querySelector('.audio-play-btn');
  if (existingButton) {
    existingButton.remove(); // 既存のボタンを更新するために削除
  }
  
  const playButton = document.createElement('button');
  playButton.textContent = '🔊 回答を聞く';
  playButton.className = 'action-btn audio-play-btn';
  playButton.style.backgroundColor = '#4a8ab8';
  playButton.style.marginTop = '10px';
  playButton.style.padding = '12px 24px'; // より大きなタップエリア
  playButton.style.fontSize = '16px';
  playButton.style.fontWeight = 'bold'; // 太字にして目立たせる
  playButton.style.borderRadius = '8px';
  playButton.style.border = 'none';
  playButton.style.cursor = 'pointer';
  playButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
  playButton.style.color = 'white';
  
  // オーディオURLをデータ属性として保存（直接アクセス用）
  playButton.dataset.audioUrl = url;
  
  // iOSに最適化された直接的なクリックハンドラ
  playButton.addEventListener('click', function(e) {
    e.preventDefault(); // デフォルト動作を防止
    
    // ボタンの状態を更新
    this.disabled = true;
    this.textContent = '▶ 再生中...';
    this.style.backgroundColor = '#999';
    
    // クリックから直接AudioContextを作成
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctx.resume().catch(() => {});
    } catch (e) {
      // エラーは無視
    }
    
    // 直接Audio要素を作成して再生
    const audioEl = new Audio();
    
    // エラーハンドラ
    audioEl.onerror = () => {
      playButton.textContent = '❌ 再生失敗 - もう一度タップ';
      playButton.style.backgroundColor = '#e74c3c';
      playButton.disabled = false;
    };
    
    // 再生完了ハンドラ
    audioEl.onended = () => {
      playButton.textContent = '✓ 再生完了';
      playButton.style.backgroundColor = '#27ae60';
      
      // 少し待ってから消す
      setTimeout(() => {
        playButton.remove();
      }, 1500);
    };
    
    // バックアップタイマー（再生が進まない場合）
    const backupTimer = setTimeout(() => {
      if (audioEl && !audioEl.paused && audioEl.currentTime < 0.5) {
        playButton.textContent = '⚠️ 再生できません';
        playButton.style.backgroundColor = '#e67e22';
        playButton.disabled = false;
      }
    }, 5000);
    
    // 明示的に音量を設定
    audioEl.volume = 1.0;
    
    // 最初に少し時間をおいてからURLを設定
    setTimeout(() => {
      // URLを設定して読み込み
      audioEl.src = url;
      audioEl.load();
      
      // oncanplaythrough より前に再生を試みる（iOSの制限対応）
      audioEl.play().catch(err => {
        safeLog('最初の再生試行エラー', err);
        
        // 少し待ってから2回目の試行
        setTimeout(() => {
          audioEl.play().catch(err2 => {
            safeLog('2回目の再生試行エラー', err2);
            playButton.textContent = '❌ 再生できません - 別の端末でお試しください';
            playButton.disabled = false;
          });
        }, 500);
      });
    }, 100);
  }, { once: false }); // 複数回のクリックを許可
  
  // ボタンを追加
  if (replyEl) {
    replyEl.appendChild(playButton);
    
    // スクロールしてボタンを表示
    setTimeout(() => {
      playButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }
  
  // 10秒後に音声が再生されていなければ説明文を追加
  setTimeout(() => {
    const stillExists = document.body.contains(playButton);
    if (stillExists && playButton.textContent.includes('再生中')) {
      const helpText = document.createElement('div');
      helpText.textContent = 'iOSの制限により音声再生に問題が発生しています。Chromeアプリをお試しください。';
      helpText.style.color = '#e74c3c';
      helpText.style.fontSize = '14px';
      helpText.style.marginTop = '8px';
      helpText.style.textAlign = 'center';
      
      playButton.parentNode.insertBefore(helpText, playButton.nextSibling);
    }
  }, 10000);
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
      
      // ユーザーインタラクションを保存
      storeUserInteraction(true);
      
      // 処理開始
      handleAI(t);
    };
    quickLinksEl.appendChild(b);
  });
}