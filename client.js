/* ─────────────────────────────────────
  client.js  ―  音声録音・GPT連携・TTS再生
  ───────────────────────────────────── */

// グローバルな再生状態管理（これを一元管理することで競合状態を防ぐ）
let globalPlaybackState = {
 active: false,          // 再生中かどうかのフラグ
 audioEl: null,          // 現在のAudio要素
 context: null,          // 現在のAudioContext
 source: null,           // 現在のAudioBufferSourceNode
 gainNode: null,         // 音量調整用GainNode
 statusUI: null,         // ステータス表示用要素
 progressBar: null,      // プログレスバー要素
 progressTimer: null,    // 進捗更新用タイマー
 timeoutTimer: null,     // タイムアウト用タイマー
 uiLocked: false,        // UI更新ロック(多重更新防止)
 retryCount: 0,          // リトライ回数
 playMethod: null,       // 現在使用中の再生方法 ('audio' または 'context')
 errorMessages: [],      // エラーメッセージ収集用
 pendingRetry: false     // 再試行保留中フラグ
};

// 現在日時のタイムスタンプ(ログ用)
function timeStamp() {
 return new Date().toISOString().substring(11, 23);
}

// デバッグヘルパー関数（エラー修正版）
const safeLog = (label, data) => {
 try {
   // コンソールが利用可能か確認
   if (typeof console === 'undefined' || !console.log) return;
   
   // タイムスタンプ付きラベル
   const stampedLabel = `[${timeStamp()}] ${label}`;

   // undefined/nullの安全な表示
   if (data === undefined) {
     console.log(`${stampedLabel}: undefined`);
     return;
   }

   if (data === null) {
     console.log(`${stampedLabel}: null`);
     return;
   }

   // 大きなデータは省略処理
   if (typeof data === 'string' && data.length > 500) {
     console.log(`${stampedLabel}:`, data.substring(0, 500) + `... [省略:${data.length - 500}文字]`);
     return;
   }

   // 通常のログ出力
   console.log(`${stampedLabel}:`, data);
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

// 再生方式をatomicに確定する関数（レースコンディション防止）
function setPlayMethod(method) {
 if (!globalPlaybackState.active) {
   return false; // 既に非アクティブなら何もしない
 }
 
 if (!globalPlaybackState.playMethod) {
   globalPlaybackState.playMethod = method;
   return true; // 再生方式が確定した
 }
 
 return globalPlaybackState.playMethod === method; // 既に設定済みならtrue、別の方式ならfalse
}

// ===== 再生リソースの完全クリーンアップ（あらゆる状況で必ず呼ばれる） =====
function cleanupPlaybackResources(silent = false) {
 // 既に非アクティブの場合は不要
 if (!globalPlaybackState.active && !window.currentAudio && silent) {
   return;
 }
 
 try {
   if (!silent) safeLog('再生リソース解放開始', { 
     hadAudio: !!globalPlaybackState.audioEl, 
     hadContext: !!globalPlaybackState.context,
     wasActive: globalPlaybackState.active,
     playMethod: globalPlaybackState.playMethod
   });
   
   // ※重要※: 個別に処理し、途中で例外が発生しても残りのリソースを解放する
   
   // Audio要素の停止・解放
   if (globalPlaybackState.audioEl) {
     try {
       globalPlaybackState.audioEl.onplaying = null;
       globalPlaybackState.audioEl.onended = null;
       globalPlaybackState.audioEl.onerror = null;
       globalPlaybackState.audioEl.onprogress = null;
       globalPlaybackState.audioEl.ontimeupdate = null;
       globalPlaybackState.audioEl.oncanplaythrough = null;
       globalPlaybackState.audioEl.pause();
       globalPlaybackState.audioEl.src = '';
     } catch (e) {
       safeLog('Audio要素解放エラー', e);
     }
     globalPlaybackState.audioEl = null;
   }
   
   // AudioBufferSourceNode停止
   if (globalPlaybackState.source) {
     try {
       globalPlaybackState.source.onended = null;
       globalPlaybackState.source.stop();
     } catch (e) {
       safeLog('SourceNode停止エラー', e);
     }
     globalPlaybackState.source = null;
   }
   
   // GainNode解放
   if (globalPlaybackState.gainNode) {
     try {
       globalPlaybackState.gainNode.disconnect();
     } catch (e) {}
     globalPlaybackState.gainNode = null;
   }
   
   // AudioContext解放
   if (globalPlaybackState.context) {
     try {
       globalPlaybackState.context.close();
     } catch (e) {
       safeLog('AudioContext解放エラー', e);
     }
     globalPlaybackState.context = null;
   }
   
   // タイマー解放
   if (globalPlaybackState.progressTimer) {
     clearInterval(globalPlaybackState.progressTimer);
     globalPlaybackState.progressTimer = null;
   }
   
   if (globalPlaybackState.timeoutTimer) {
     clearTimeout(globalPlaybackState.timeoutTimer);
     globalPlaybackState.timeoutTimer = null;
   }
   
   // 古い方式の変数もクリーンアップ
   if (window.currentAudio) {
     try {
       window.currentAudio.pause();
       window.currentAudio.src = '';
     } catch (e) {}
     window.currentAudio = null;
   }
   
   // エラーメッセージリスト初期化
   globalPlaybackState.errorMessages = [];
   
   // アクティブ状態・UI状態のリセット
   globalPlaybackState.active = false;
   globalPlaybackState.uiLocked = false;
   globalPlaybackState.playMethod = null;
   globalPlaybackState.pendingRetry = false;
   isPlayingAudio = false;
   
   if (!silent) safeLog('再生リソース解放完了', null);
 } catch (e) {
   safeLog('クリーンアップ中の例外', e);
   // 確実に状態をリセット
   globalPlaybackState.active = false;
   globalPlaybackState.uiLocked = false;
   globalPlaybackState.playMethod = null;
   globalPlaybackState.pendingRetry = false;
   isPlayingAudio = false;
 }
}

// iOS/Safari用音声初期化処理
function initializeAudioSystem() {
 if (window._audioSystemInitialized) return Promise.resolve();
 
 return new Promise((resolve) => {
   try {
     safeLog('音声システム初期化開始', { isIOS, isSafari });
     
     // 無音のMP3データURL
     const silentMP3 = 'data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAASAAAeMwAUFBQUFCIiIiIiIjAwMDAwPj4+Pj4+TExMTExZWVlZWVlnZ2dnZ3V1dXV1dYODg4ODkZGRkZGRn5+fn5+frKysrKy6urq6urrIyMjIyNbW1tbW1uTk5OTk8vLy8vLy//////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAQKAAAAAAAAHjOZTf9/AAAAAAAAAAAAAAAAAAAAAP/7kGQAAANUMEoFPeACNQV40KEYABEY41g5vAAA9RjpZxRwAImU+W8eshaFpAQgALAAYALATx/nYDYCMJ0HITQYYA7AH4c7MoGsnCMU5pnW+OQnBcDrQ9Xx7w37/D+PimYavV8elKUpT5fqx5VjV6vZ38eJR48eThbqx5VjTsalKUpT5dpxqYW6pSn/9lRTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUp97KCpTEZ6vV8eplKUp9vF7qx5VjTsalKUpT5dpyYW6sep//Z';
     
     // 無音のAudio要素を作成
     const silentAudio = new Audio(silentMP3);
     silentAudio.volume = 0.1; // 小さめの音量
     
     // AudioContextを作成して再開
     const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
     audioCtx.resume().catch(() => {});
     
     // 無音再生の成功を記録する
     let playPromise = null;
     
     try {
       // Audioエレメントで再生
       playPromise = silentAudio.play();
     } catch (e) {
       safeLog('無音再生エラー', e);
     }
     
     // 再生結果を処理
     if (playPromise && playPromise.then) {
       playPromise
         .then(() => {
           safeLog('無音再生成功', null);
           window._audioSystemInitialized = true;
           resolve(true);
         })
         .catch(err => {
           safeLog('無音再生Promise失敗', err);
           // エラーでも続行（初期化は試みたとみなす）
           window._audioSystemInitialized = true;
           resolve(false);
         });
     } else {
       // Promiseがなければ成功とみなす
       safeLog('無音再生（非Promise）', null);
       window._audioSystemInitialized = true;
       resolve(true);
     }
     
     // バックアップタイマー（3秒後に強制的に初期化完了とする）
     setTimeout(() => {
       if (!window._audioSystemInitialized) {
         safeLog('音声初期化タイムアウト', null);
         window._audioSystemInitialized = true;
         resolve(false);
       }
     }, 3000);
   } catch (e) {
     safeLog('音声システム初期化エラー', e);
     window._audioSystemInitialized = true; // エラーでも初期化は試みたとみなす
     resolve(false);
   }
 });
}

// 古い初期化関数は新しい関数を呼び出すようにフォワーディング
function initAudioForIOS() {
 initializeAudioSystem();
}

// ユーザーインタラクションの保存と音声初期化
function storeUserInteraction(isImportant = false) {
 safeLog('ユーザーインタラクション保存', { isImportant, count: ++audioInteractionCount });
 
 // iOS/Safari環境での特別処理
 if (needsSpecialHandling) {
   initializeAudioSystem();
 }
 
 // インタラクションを保存
 userInteractionPromise = Promise.resolve(true);
}

// iOS Safariでの音声再生問題を解決するための初期化
if (needsSpecialHandling) {
 document.addEventListener('click', initializeAudioSystem, { once: true });
 document.addEventListener('touchstart', initializeAudioSystem, { once: true });
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
 if (!vadActive || isPlayingAudio || globalPlaybackState.active) return;
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

// ===== マイク録音の停止処理改善 =====
function stopRecordingSafely() {
 try {
   if (mediaRecorder && mediaRecorder.state === 'recording') {
     safeLog('録音停止処理開始', mediaRecorder.state);
     
     // 即時停止を試みる
     try {
       mediaRecorder.stop();
     } catch (stopError) {
       safeLog('mediaRecorder.stop()エラー', stopError);
     }
     
     // VAD関連状態リセット
     speaking = false;
     vadActive = false;
     
     // 確実にタイマーをクリアする
     if (silenceTimer) {
       clearTimeout(silenceTimer);
       silenceTimer = null;
     }
     
     // マイクストリームトラックを停止
     if (micStream) {
       try {
         micStream.getTracks().forEach(track => {
           if (track.readyState === 'live') {
             track.stop();
             safeLog('マイクトラック停止成功', track.kind);
           }
         });
       } catch (trackError) {
         safeLog('マイクトラック停止エラー', trackError);
       }
     }
     
     // AudioContext関連リソース解放
     if (processor) {
       try {
         processor.disconnect();
       } catch (e) {}
     }
     
     // statusを更新
     statusEl.textContent = '🧠 回答中…';
     
     safeLog('録音停止処理完了', null);
   } else {
     safeLog('録音停止不要（既に停止中）', mediaRecorder ? mediaRecorder.state : 'undefined');
   }
 } catch (e) {
   safeLog('録音停止失敗', e);
   // 失敗しても状態は更新
   speaking = false;
   vadActive = false;
   statusEl.textContent = '🧠 回答中…';
 }
}

// 元のstopRecording関数を安全版に置き換え
function stopRecording() {
 stopRecordingSafely();
}

// マイク停止ボタン処理用関数
function setupMicStopButton() {
 const stopButton = document.getElementById('mic-stop-button');
 if (!stopButton) return;
 
 // 既存のイベントリスナーを削除
 const newStopButton = stopButton.cloneNode(true);
 stopButton.parentNode.replaceChild(newStopButton, stopButton);
 
 // 新しいイベントリスナーを追加
 newStopButton.addEventListener('click', (e) => {
   e.preventDefault();
   safeLog('マイク停止ボタンがクリックされました', null);
   stopRecordingSafely();
 });
}

// ページ読み込み時にマイク停止ボタンをセットアップ
document.addEventListener('DOMContentLoaded', setupMicStopButton);

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

   // TTS処理開始 - 改善版のTTS処理関数を使用
   await handleTTSAudio(aiResponse);
   
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

/* ───────── UI関連のヘルパー関数 ───────── */

// プログレスバーの更新
function updateProgressBar(percent) {
 if (!globalPlaybackState.progressBar) return;
 
 try {
   // 値の範囲を0-100に制限
   const safePercent = Math.max(0, Math.min(100, percent));
   globalPlaybackState.progressBar.style.width = `${safePercent}%`;
 } catch (e) {
   safeLog('プログレスバー更新エラー', e);
 }
}

// ステータステキストの更新
function updateStatusText(message) {
 if (!globalPlaybackState.statusUI) return;
 
 try {
   globalPlaybackState.statusUI.textContent = message;
   
   // アクセシビリティのための通知
   const ariaAnnounce = document.querySelector('.sr-announcer');
   if (ariaAnnounce) {
     ariaAnnounce.textContent = message;
   }
 } catch (e) {
   safeLog('ステータス更新エラー', e);
 }
}

// UI状態の一括更新（排他制御による安全な更新）
function updatePlaybackUI(state, message, percent) {
 // UIロック状態確認
 if (globalPlaybackState.uiLocked) {
   safeLog('UI更新スキップ（ロック中）', { state, message });
   return;
 }
 
 try {
   // ロック設定
   globalPlaybackState.uiLocked = true;
   
   // ボタン更新
   if (state) {
     // 値がある場合のみ更新
     const button = document.querySelector('.audio-play-btn');
     if (button && document.body.contains(button)) {
       updatePlayButton(button, state, message);
     }
   }
   
   // ステータス更新
   if (message) {
     updateStatusText(message);
   }
   
   // プログレスバー更新
   if (percent !== undefined) {
     updateProgressBar(percent);
   }
   
   // ロック解除
   globalPlaybackState.uiLocked = false;
 } catch (e) {
   safeLog('UI一括更新エラー', e);
   globalPlaybackState.uiLocked = false; // 確実に解除
 }
}

// 再生ボタンの状態更新
function updatePlayButton(button, state, message) {
 if (!button || !document.body.contains(button)) return;
 
 try {
   switch(state) {
     case 'loading':
       button.textContent = '▶ 準備中...';
       button.style.backgroundColor = '#999';
       button.disabled = true;
       break;
     case 'playing':
       button.textContent = '▶ 再生中...';
       button.style.backgroundColor = '#4a8ab8';
       button.disabled = true;
       break;
     case 'success':
       button.textContent = '✓ 再生完了';
       button.style.backgroundColor = '#27ae60';
       button.disabled = true;
       button.dataset.played = 'true';
       break;
     case 'error':
       button.textContent = message || '❌ 再生失敗';
       button.style.backgroundColor = '#e74c3c';
       button.disabled = false;
       break;
     case 'retry':
       button.textContent = '🔄 再試行中...';
       button.style.backgroundColor = '#f39c12';
       button.disabled = true;
       break;
     case 'retryNeeded':
       button.textContent = '🔄 もう一度タップして再試行';
       button.style.backgroundColor = '#f39c12';
       button.disabled = false;
       break;
     case 'ready':
       button.textContent = '🔊 回答を聞く';
       button.style.backgroundColor = '#4a8ab8';
       button.disabled = false;
       break;
   }
 } catch (e) {
   safeLog('ボタン更新エラー', e);
 }
}

// ヘルプメッセージの表示
function showHelpMessage(container, message) {
 if (!container || !document.body.contains(container)) return;
 
 try {
   // 既存のヘルプを確認
   const existingHelp = container.querySelector('.audio-help-text');
   if (existingHelp) {
     existingHelp.remove();
   }
   
   const helpEl = document.createElement('div');
   helpEl.className = 'audio-help-text';
   helpEl.style.color = '#e74c3c';
   helpEl.style.fontSize = '14px';
   helpEl.style.marginTop = '10px';
   helpEl.style.padding = '10px';
   helpEl.style.backgroundColor = '#fff3f3';
   helpEl.style.borderRadius = '5px';
   helpEl.style.border = '1px solid #ffcdd2';
   
   // Safari/iOS 特別メッセージ
   const isNewerIOS = /iP(hone|ad|od).*OS 1[7-9]/.test(navigator.userAgent);
   
   helpEl.innerHTML = message || (isNewerIOS ? `
     <p>iOSデバイスで音声再生に問題が発生しました。</p>
     <ul style="text-align:left; margin-top:5px; padding-left:20px;">
       <li>もう一度ボタンをタップしてください</li>
       <li>iOS 17.4以上では音声の自動再生に追加の権限が必要な場合があります</li>
       <li>Chromeアプリをインストールして開く方法もお試しください</li>
       <li>端末の音量が上がっているか確認してください</li>
     </ul>
   ` : `
     <p>音声の再生に問題が発生しました。</p>
     <ul style="text-align:left; margin-top:5px; padding-left:20px;">
       <li>もう一度ボタンをタップする</li>
       <li>Chromeアプリをインストールして開く</li>
       <li>端末の音量が上がっているか確認する</li>
       <li>端末を再起動する</li>
     </ul>
   `);
   
   container.appendChild(helpEl);
 } catch (e) {
   safeLog('ヘルプメッセージ表示エラー', e);
 }
}

// 再生完了時の共通処理
function finalizePlaybackSuccess(container) {
 // 既に非アクティブなら何もしない
 if (!globalPlaybackState.active) return;
 
 safeLog('再生完了処理', { playMethod: globalPlaybackState.playMethod });
 
 // UI更新
 updatePlaybackUI('success', '再生完了', 100);
 
 // 3秒後にステータス非表示
 setTimeout(() => {
   if (globalPlaybackState.statusUI) {
     globalPlaybackState.statusUI.style.display = 'none';
   }
   if (container && document.body.contains(container) && container.querySelector('.progress-container')) {
     container.querySelector('.progress-container').style.display = 'none';
   }
 }, 3000);
 
 // リソース解放
 cleanupPlaybackResources();
}

// 再生エラー時の共通処理
function finalizePlaybackError(container, errorMessage) {
 // 既に非アクティブなら何もしない
 if (!globalPlaybackState.active) return;
 
 // エラーメッセージを収集
 if (errorMessage) {
   globalPlaybackState.errorMessages.push(errorMessage);
 }
 
 // 両方のメソッドで失敗したか、リトライ上限に達したら最終エラー表示
 if (globalPlaybackState.retryCount >= 2 || globalPlaybackState.errorMessages.length >= 2) {
   safeLog('再生失敗確定', {
     retries: globalPlaybackState.retryCount,
     errors: globalPlaybackState.errorMessages
   });
   
   // iOSデバイスではユーザー操作による再試行を可能にする
   if (needsSpecialHandling && !globalPlaybackState.pendingRetry) {
     // 再試行設定（ボタンを再度アクティブにする）
     updatePlaybackUI('retryNeeded', 'タップして再試行してください');
     
     // ヘルプ表示
     showHelpMessage(container);
     
     // 再試行フラグを設定
     globalPlaybackState.pendingRetry = true;
     
     // 一部のリソースだけ解放（完全解放しない）
     // Audio要素の停止
     if (globalPlaybackState.audioEl) {
       try {
         globalPlaybackState.audioEl.pause();
       } catch (e) {}
     }
     
     // AudioContext停止
     if (globalPlaybackState.source) {
       try {
         globalPlaybackState.source.stop();
       } catch (e) {}
     }
     
     // タイマー解放
     if (globalPlaybackState.progressTimer) {
       clearInterval(globalPlaybackState.progressTimer);
       globalPlaybackState.progressTimer = null;
     }
     
     if (globalPlaybackState.timeoutTimer) {
       clearTimeout(globalPlaybackState.timeoutTimer);
       globalPlaybackState.timeoutTimer = null;
     }
   } else {
     // 完全に失敗 - UI更新して全リソース解放
     updatePlaybackUI('error', '再生に失敗しました');
     
     // ヘルプ表示
     showHelpMessage(container);
     
     // リソース解放
     cleanupPlaybackResources();
   }
 } else {
   // まだリトライ可能
   safeLog('再生エラー - リトライ待機', { 
     count: globalPlaybackState.retryCount,
     errors: globalPlaybackState.errorMessages
   });
 }
}

/* ───────── 音声再生 ───────── */
// 音声再生ボタンを作成して表示する関数
function showAndConfigurePlayButton(url, container) {
 try {
   safeLog('再生ボタン作成', { container: !!container, url: url.slice(0, 30) + '...' });
   
   // 既存ボタン確認・削除
   const existingContainer = document.querySelector('.audio-player-container');
   if (existingContainer) {
     existingContainer.remove();
   }
   
   // ボタン作成
   const playButton = document.createElement('button');
   playButton.textContent = '🔊 回答を聞く';
   playButton.className = 'action-btn audio-play-btn';
   playButton.style.backgroundColor = '#4a8ab8';
   playButton.style.margin = '15px 0';
   playButton.style.padding = '12px 24px';
   playButton.style.fontSize = '16px';
   playButton.style.fontWeight = 'bold';
   playButton.style.borderRadius = '8px';
   playButton.style.border = 'none';
   playButton.style.cursor = 'pointer';
   playButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.2)';
   playButton.style.color = 'white';
   playButton.style.width = '100%';  // モバイル向け幅拡大
   playButton.setAttribute('role', 'button');
   playButton.setAttribute('aria-label', '音声で回答を聞く');
   
   // プログレスバー作成
   const progressContainer = document.createElement('div');
   progressContainer.className = 'progress-container';
   progressContainer.style.width = '100%';
   progressContainer.style.height = '8px';
   progressContainer.style.backgroundColor = '#e0e0e0';
   progressContainer.style.borderRadius = '4px';
   progressContainer.style.overflow = 'hidden';
   progressContainer.style.marginTop = '10px';
   progressContainer.style.display = 'none';
   
   const progressBar = document.createElement('div');
   progressBar.className = 'progress-bar';
   progressBar.style.width = '0%';
   progressBar.style.height = '100%';
   progressBar.style.backgroundColor = '#4CAF50';
   progressBar.style.transition = 'width 0.1s';
   progressContainer.appendChild(progressBar);
   
   // ステータス表示用エリア
   const statusText = document.createElement('div');
   statusText.className = 'audio-status';
   statusText.style.fontSize = '14px';
   statusText.style.marginTop = '8px';
   statusText.style.textAlign = 'center';
   statusText.style.color = '#666';
   statusText.style.display = 'none';
   
   // スクリーンリーダー通知用（非表示）
   const srAnnouncer = document.createElement('div');
   srAnnouncer.className = 'sr-announcer';
   srAnnouncer.setAttribute('aria-live', 'polite');
   srAnnouncer.style.position = 'absolute';
   srAnnouncer.style.width = '1px';
   srAnnouncer.style.height = '1px';
   srAnnouncer.style.padding = '0';
   srAnnouncer.style.margin = '-1px';
   srAnnouncer.style.overflow = 'hidden';
   srAnnouncer.style.clip = 'rect(0, 0, 0, 0)';
   srAnnouncer.style.whiteSpace = 'nowrap';
   srAnnouncer.style.border = '0';
   
   // コンテナに追加
   const playerContainer = document.createElement('div');
   playerContainer.className = 'audio-player-container';
   playerContainer.appendChild(playButton);
   playerContainer.appendChild(progressContainer);
   playerContainer.appendChild(statusText);
   playerContainer.appendChild(srAnnouncer);
   
   // ページに追加
   if (container && document.body.contains(container)) {
     container.appendChild(playerContainer);
     
     // スクロールしてボタンを表示
     setTimeout(() => {
       if (playButton && document.body.contains(playButton)) {
         playButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
       }
     }, 300);
   } else if (replyEl && document.body.contains(replyEl)) {
     replyEl.appendChild(playerContainer);
     
     // スクロールしてボタンを表示
     setTimeout(() => {
       if (playButton && document.body.contains(playButton)) {
         playButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
       }
     }, 300);
   } else {
     safeLog('ボタン追加先コンテナが見つかりません', null);
     return null;
   }
   
   // 音声URL保存
   playButton.dataset.audioUrl = url;
   
   // グローバル状態参照設定
   globalPlaybackState.progressBar = progressBar;
   globalPlaybackState.statusUI = statusText;
   
   // 再生イベント設定
   playButton.addEventListener('click', (e) => {
     e.preventDefault();
     
     // ボタンが消えていないか確認
     if (!document.body.contains(playButton)) {
       safeLog('ボタンがDOM上に存在しないためクリックを無視', null);
       return;
     }
     
     // 再試行モードの場合
     if (globalPlaybackState.pendingRetry) {
       safeLog('再試行モードでクリック', null);
       // 状態をリセット
       globalPlaybackState.pendingRetry = false;
       globalPlaybackState.errorMessages = [];
       globalPlaybackState.retryCount = 0;
       
       // オーディオシステムを再初期化
       initializeAudioSystem().then(() => {
         // 音声URLが保存されていれば再生
         const savedUrl = playButton.dataset.audioUrl;
         if (savedUrl) {
           updatePlaybackUI('retry', '再試行中...');
           playAudioWithFallback(savedUrl, playButton, playerContainer);
         } else {
           updatePlaybackUI('error', 'URLが見つかりません');
         }
       });
       return;
     }
     
     // 多重クリック防止
     if (globalPlaybackState.active) {
       safeLog('再生中のため、クリックを無視します', null);
       updateStatusText('現在再生中です...');
       statusText.style.display = 'block';
       // 2秒後に状態表示を消す
       setTimeout(() => {
         if (statusText && document.body.contains(statusText)) {
           statusText.style.display = 'none';
         }
       }, 2000);
       return;
     }
     
     // 再生済みチェック（UI改善のため直接メッセージを表示）
     if (playButton.dataset.played === 'true') {
       safeLog('既に再生済み', null);
       updateStatusText('既に再生済みです。もう一度聞く場合はページを更新してください。');
       statusText.style.display = 'block';
       
       // 3秒後に非表示
       setTimeout(() => {
         if (statusText && document.body.contains(statusText)) {
           statusText.style.display = 'none';
         }
       }, 3000);
       return;
     }
     
     // iOS/Safari対応の初期化を実行後、再生開始
     initializeAudioSystem().then(() => {
       // 実際の再生処理を開始
       playAudioWithFallback(url, playButton, playerContainer);
     });
   });
   
   safeLog('再生ボタン作成完了', null);
   return playButton;
 } catch (e) {
   safeLog('再生ボタン作成エラー', e);
   return null;
 }
}

// 音声再生戦略実装（改善版：排他制御の明確化）
function playAudioWithFallback(url, button, container) {
 // 既に再生中なら何もしない
 if (globalPlaybackState.active) {
   safeLog('既に再生中のため、再生を開始しません', null);
   return;
 }
 
 // ボタンが存在するか確認
 if (button && !document.body.contains(button)) {
   safeLog('ボタンがDOM上に存在しないため再生を開始しません', null);
   return;
 }
 
 // コンテナが存在するか確認
 if (container && !document.body.contains(container)) {
   safeLog('コンテナがDOM上に存在しないため再生を開始しません', null);
   return;
 }
 
 // 再生開始前の状態初期化
 try {
   // 既存リソースの確実なクリーンアップ
   cleanupPlaybackResources();
   
   // 状態初期化
   globalPlaybackState.active = true;
   isPlayingAudio = true; // 古い実装との互換性のため
   globalPlaybackState.retryCount = 0;
   globalPlaybackState.uiLocked = false;
   globalPlaybackState.errorMessages = [];
   globalPlaybackState.playMethod = null;
   globalPlaybackState.pendingRetry = false;
   
   // UI初期化
   if (container && document.body.contains(container)) {
     const progressContainer = container.querySelector('.progress-container');
     if (progressContainer) {
       progressContainer.style.display = 'block';
     }
     
     const statusTextEl = container.querySelector('.audio-status');
     if (statusTextEl) {
       statusTextEl.style.display = 'block';
     }
   }
   
   updatePlaybackUI('loading', '音声準備中...', 0);
   
   // グローバルタイムアウト設定（15秒）
   globalPlaybackState.timeoutTimer = setTimeout(() => {
     if (globalPlaybackState.active) {
       safeLog('再生タイムアウト', null);
       
       // 再生中断
       finalizePlaybackError(container, 'タイムアウト');
     }
   }, 15000);
   
   safeLog('フォールバック再生開始', { url: url.slice(0, 30) + '...' });
   
   // Audio要素とAudioContext両方で再生を試みる（優先度：Audio要素→AudioContext）
   // 排他制御：どちらかが成功したらもう片方は即時停止する
   playWithAudioElement(url, button, container);
   
   // 少し遅延してAudioContextで再生を試行（Audio要素より少し遅く開始）
   setTimeout(() => {
     // Audio要素で成功していなければAudioContextを試行
     if (globalPlaybackState.active && !globalPlaybackState.playMethod) {
       playWithAudioContext(url, button, container);
     }
   }, 500);
   
 } catch (e) {
   safeLog('再生初期化エラー', e);
   
   // エラー表示
   finalizePlaybackError(container, '初期化エラー: ' + e.message);
 }
}

// Audio要素による再生
function playWithAudioElement(url, button, container) {
 try {
   // 既に他の方法で再生中なら何もしない
   if (!globalPlaybackState.active || globalPlaybackState.playMethod) {
     safeLog('Audio要素再生スキップ（既に他の方法で再生中）', { active: globalPlaybackState.active, method: globalPlaybackState.playMethod });
     return;
   }
   
   safeLog('Audio要素による再生開始', { url: url.slice(0, 30) + '...' });
   
   // Audio要素作成
   const audioEl = new Audio();
   globalPlaybackState.audioEl = audioEl;
   
   // 読み込み進捗
   audioEl.addEventListener('progress', () => {
     try {
       // 他の方法で既に再生中なら何もしない
       if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'audio')) {
         return;
       }
       
       if (audioEl.buffered.length > 0) {
         const loadPercent = (audioEl.buffered.end(0) / audioEl.duration) * 100;
         if (!isNaN(loadPercent)) {
           updatePlaybackUI(null, `読み込み中... ${Math.round(loadPercent)}%`);
         }
       }
     } catch (e) {}
   });
   
   // 再生準備完了
   audioEl.addEventListener('canplaythrough', () => {
     // 他の方法で既に再生中なら何もしない
     if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'audio')) {
       return;
     }
     
     safeLog('Audio要素再生準備完了', { duration: audioEl.duration });
     updatePlaybackUI(null, '再生準備完了');
   });
   
   // 再生開始 - 修正：atomic操作でフラグを設定
   audioEl.addEventListener('playing', () => {
     // 再生方式をatomicに確定
     if (setPlayMethod('audio')) {
       // 再生方法が'audio'で確定
       safeLog('Audio要素再生開始', null);
       updatePlaybackUI('playing', '再生中...');
     } else {
       // 既に他の方法で再生中
       safeLog('Audio要素再生中だが他の方法で既に再生中', { playMethod: globalPlaybackState.playMethod });
       try {
         audioEl.pause();
       } catch (e) {}
       return;
     }
   });
   
   // 再生進捗
   audioEl.addEventListener('timeupdate', () => {
     // 再生中でなければイベント無視
     if (!globalPlaybackState.active || globalPlaybackState.playMethod !== 'audio') {
       return;
     }
     
     if (audioEl.duration > 0 && !isNaN(audioEl.duration)) {
       const percent = (audioEl.currentTime / audioEl.duration) * 100;
       
       // 進捗バー更新
       updateProgressBar(percent);
       
       // 残り時間計算（5秒以上の場合のみ表示）
       const remaining = Math.ceil(audioEl.duration - audioEl.currentTime);
       if (remaining > 5) {
         updateStatusText(`再生中... (残り約${remaining}秒)`);
       }
     }
   });
   
   // 再生完了
   audioEl.addEventListener('ended', () => {
     safeLog('Audio要素再生完了', null);
     
     // 既に非アクティブなら何もしない
     if (!globalPlaybackState.active || globalPlaybackState.playMethod !== 'audio') {
       return;
     }
     
     // 完了処理
     finalizePlaybackSuccess(container);
   });
   
   // エラー処理
   audioEl.addEventListener('error', (e) => {
     const errorCode = audioEl.error ? audioEl.error.code : 'unknown';
     safeLog('Audio要素エラー', { code: errorCode, message: e.message || 'エラーの詳細不明' });
     
     // 既に他の方法で再生中または完了済みなら何もしない
     if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'audio')) {
       return;
     }
     
     // エラーメッセージを収集
     globalPlaybackState.errorMessages.push(`Audio要素エラー: ${errorCode}`);
     
     // Audio要素は失敗したためnullに設定（AudioContextに任せる）
     globalPlaybackState.audioEl = null;
     
     // AudioContextでの再生が成功していなければ失敗を表示
     finalizePlaybackError(container);
   });
   
   // 読み込み開始
   audioEl.src = url;
   audioEl.preload = 'auto';
   audioEl.load();
   
   // 再生開始を試みる
   const playPromise = audioEl.play();
   if (playPromise && playPromise.then) {
     playPromise.catch(err => {
       safeLog('Audio要素play()失敗', err);
       
       // 既に他の方法で再生中または完了済みなら何もしない
       if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'audio')) {
         return;
       }
       
       // エラーメッセージを収集
       globalPlaybackState.errorMessages.push(`Audio要素play失敗: ${err.message || 'unknown'}`);
       finalizePlaybackError(container);
     });
   }
 } catch (e) {
   safeLog('Audio要素処理エラー', e);
   
   // エラーメッセージを収集
   if (globalPlaybackState.active) {
     globalPlaybackState.errorMessages.push(`Audio要素例外: ${e.message || 'unknown'}`);
     finalizePlaybackError(container);
   }
 }
}

// AudioContextによる再生
function playWithAudioContext(url, button, container) {
 (async () => {
   try {
     // 既に他の方法で再生中なら何もしない
     if (!globalPlaybackState.active || globalPlaybackState.playMethod) {
       safeLog('AudioContext再生スキップ（既に他の方法で再生中）', { active: globalPlaybackState.active, method: globalPlaybackState.playMethod });
       return;
     }
     
     safeLog('AudioContext再生開始', { url: url.slice(0, 30) + '...' });
     updatePlaybackUI(null, '音声データ取得中...');
     
     // 音声データをfetch
     const response = await fetch(url);
     if (!response.ok) {
       throw new Error(`音声取得エラー: ${response.status}`);
     }
     
     // fetch完了時点でもまだactiveか確認（他の方法で再生中でないか）
     if (!globalPlaybackState.active || globalPlaybackState.playMethod) {
       safeLog('AudioContext再生キャンセル（fetch後非アクティブ）', null);
       return;
     }
     
     updatePlaybackUI(null, '音声データ処理中...');
     
     // バイナリデータ取得
     const arrayBuffer = await response.arrayBuffer();
     
// バイナリ取得時点でもまだactiveか確認
     if (!globalPlaybackState.active || globalPlaybackState.playMethod) {
       safeLog('AudioContext再生キャンセル（arrayBuffer後非アクティブ）', null);
       return;
     }
     
     // AudioContext作成
     let ctx = null;
     try {
       ctx = new (window.AudioContext || window.webkitAudioContext)();
       globalPlaybackState.context = ctx;
       await ctx.resume();
       
       // デコード
       const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
       
       // デコード完了時点でもまだactiveか確認
       if (!globalPlaybackState.active || globalPlaybackState.playMethod) {
         safeLog('AudioContext再生キャンセル（decode後非アクティブ）', null);
         await ctx.close();
         globalPlaybackState.context = null;
         return;
       }
       
       // 再生方式をatomicに確定
       if (!setPlayMethod('context')) {
         safeLog('AudioContext再生中止 - 別の方法が既に使用中', { playMethod: globalPlaybackState.playMethod });
         await ctx.close();
         globalPlaybackState.context = null;
         return;
       }
       
       // SourceNode作成
       const source = ctx.createBufferSource();
       globalPlaybackState.source = source;
       source.buffer = audioBuffer;
       
       // GainNode作成（音量調整用）
       const gainNode = ctx.createGain();
       globalPlaybackState.gainNode = gainNode;
       gainNode.gain.value = 1.0; // 標準音量
       
       // 接続
       source.connect(gainNode);
       gainNode.connect(ctx.destination);
       
       // 再生進捗更新用タイマー
       const duration = audioBuffer.duration;
       let startTime = ctx.currentTime;
       
       safeLog('AudioContext再生準備完了', { duration });
       
       // 再生開始
       source.start(0);
       updatePlaybackUI('playing', '再生中...');
       
       // 進捗更新タイマー設定
       globalPlaybackState.progressTimer = setInterval(() => {
         // 既に非アクティブまたは他の方法で再生中なら停止
         if (!globalPlaybackState.active || globalPlaybackState.playMethod !== 'context') {
           clearInterval(globalPlaybackState.progressTimer);
           globalPlaybackState.progressTimer = null;
           return;
         }
         
         const elapsed = ctx.currentTime - startTime;
         const percent = Math.min(100, (elapsed / duration) * 100);
         updateProgressBar(percent);
         
         // 残り時間計算（5秒以上の場合のみ表示）
         const remaining = Math.ceil(duration - elapsed);
         if (remaining > 5) {
           updateStatusText(`再生中... (残り約${remaining}秒)`);
         }
         
         // 再生終了判定
         if (percent >= 99.5) {
           clearInterval(globalPlaybackState.progressTimer);
           globalPlaybackState.progressTimer = null;
           
           // 完了処理
           if (globalPlaybackState.active && globalPlaybackState.playMethod === 'context') {
             safeLog('AudioContext再生完了（タイマーによる検出）', null);
             finalizePlaybackSuccess(container);
           }
         }
       }, 100);
       
       // 再生完了イベント
       source.onended = () => {
         safeLog('AudioContext再生完了イベント', null);
         
         // 既に非アクティブなら何もしない
         if (!globalPlaybackState.active || globalPlaybackState.playMethod !== 'context') {
           return;
         }
         
         // 完了処理
         finalizePlaybackSuccess(container);
       };
     } catch (decodingError) {
       // デコード中のエラー
       safeLog('AudioContext デコード/再生エラー', decodingError);
       
       // コンテキスト解放を確実に行う
       if (ctx) {
         try {
           await ctx.close();
         } catch (closeError) {}
         globalPlaybackState.context = null;
       }
       
       // 既に他の方法で再生中または完了済みなら何もしない
       if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'context')) {
         return;
       }
       
       // エラーメッセージを収集
       globalPlaybackState.errorMessages.push(`AudioContext デコードエラー: ${decodingError.message || 'unknown'}`);
       finalizePlaybackError(container, decodingError.message);
     }
   } catch (e) {
     safeLog('AudioContext再生エラー', e);
     
     // コンテキスト解放を確実に行う
     if (globalPlaybackState.context) {
       try {
         await globalPlaybackState.context.close();
       } catch (closeError) {}
       globalPlaybackState.context = null;
     }
     
     // 既に他の方法で再生中または完了済みなら何もしない
     if (!globalPlaybackState.active || (globalPlaybackState.playMethod && globalPlaybackState.playMethod !== 'context')) {
       return;
     }
     
     // エラーメッセージを収集
     globalPlaybackState.errorMessages.push(`AudioContext再生エラー: ${e.message || 'unknown'}`);
     finalizePlaybackError(container, e.message);
   }
 })();
}

// TTS URL取得・再生関数
async function handleTTSAudio(aiResponse) {
 try {
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
       headers: { 
         'Content-Type': 'application/json',
         'Accept': 'audio/mpeg' // MP3形式を明示的にリクエスト
       },
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
   if (ttsResponse.audioUrl && typeof ttsResponse.audioUrl === 'string' && 
      (ttsResponse.audioUrl.startsWith('http') || ttsResponse.audioUrl.startsWith('/'))) {
     safeLog('音声URL取得成功', { urlPreview: ttsResponse.audioUrl.substring(0, 50) + '...' });

     try {
       // iOS/Safariでは再生ボタンを表示
       const playButton = showAndConfigurePlayButton(ttsResponse.audioUrl, replyEl);
       
       if (playButton) {
         if (needsSpecialHandling) {
           safeLog('iOS/Safari環境のため再生ボタン表示のみ', null);
         } else {
           // 他の環境では自動再生を試みる（ユーザーエクスペリエンス向上）
           setTimeout(() => {
             try {
               if (playButton && document.body.contains(playButton) && !globalPlaybackState.active) {
                 playButton.click();
                 safeLog('自動再生リクエスト完了', null);
               }
             } catch (autoplayError) {
               safeLog('自動再生リクエストエラー', autoplayError);
               // エラーでも続行（ボタンは表示済み）
             }
           }, 300);
         }
       } else {
         safeLog('再生ボタン作成失敗', null);
       }
     } catch (playError) {
       safeLog('音声再生エラー - ボタン表示へフォールバック', playError);
       // 再生エラーの場合もボタンを表示
       showAndConfigurePlayButton(ttsResponse.audioUrl, replyEl);
     }
   } else if (ttsResponse.error) {
     safeLog('TTS エラー', {
       error: ttsResponse.error,
       detail: ttsResponse.errorDetail || '',
     });
     // エラーがあってもテキスト応答は表示済みなので続行
   } else {
     safeLog('有効な音声URLが見つかりません', ttsResponse);
     // 音声なしでも続行
   }
   
   // 最終的な状態更新
   statusEl.textContent = '🎧 次の発話を検知します';
   vadActive = true;
   
 } catch (e) {
   safeLog('TTS処理全体エラー', e);
   statusEl.textContent = '❌ 音声生成失敗: ' + (e.message || '不明なエラー');
   
   // エラーでも処理続行
   vadActive = true;
 }
}

// 旧実装のplayAudio関数も改善（互換性のため維持）
function playAudio(url) {
 return new Promise((resolve, reject) => {
   try {
     safeLog('playAudio: 旧方式の音声再生開始', { url: url.slice(0, 60) + '…' });
     
     // 古い方式でも新しいメソッドを使用
     const button = showAndConfigurePlayButton(url, replyEl);
     
     if (!button) {
       throw new Error('再生ボタンの作成に失敗しました');
     }
     
     // 非iOS/Safariの場合は自動再生を試みる
     if (!needsSpecialHandling) {
       setTimeout(() => {
         try {
           if (button && document.body.contains(button) && !globalPlaybackState.active) {
             safeLog('playAudio: 自動再生を試行', null);
             button.click();
             
             // 成功とみなす（実際の結果は非同期で処理）
             resolve();
           } else {
             resolve(); // ボタンが無効な場合も成功とみなす
           }
         } catch (e) {
           safeLog('playAudio: 自動再生失敗', e);
           resolve(); // 失敗しても続行（ボタンは表示済み）
         }
       }, 300);
     } else {
       // iOS/Safariの場合はボタン表示のみで成功扱い
       resolve();
     }
   } catch (err) {
     safeLog('playAudio: 致命的エラー', err);
     reject(err);
   }
 });
}

// 旧メソッドのフォワーディング（互換性のため）
function showPlayButton(url) {
 return showAndConfigurePlayButton(url, replyEl);
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

// マイク停止ボタン設定
document.addEventListener('DOMContentLoaded', () => {
 const stopButton = document.getElementById('mic-stop-button');
 if (stopButton) {
   stopButton.addEventListener('click', (e) => {
     e.preventDefault();
     safeLog('マイク停止ボタンがクリックされました', null);
     stopRecordingSafely();
   });
 }
});