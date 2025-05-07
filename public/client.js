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
const recogEl  = document.getElementById('recognized');
const replyEl  = document.getElementById('reply');
const quickLinksEl = document.getElementById('quick-links');

let audioCtx, processor, micStream, mediaRecorder;
let vadActive = false, speaking = false, silenceTimer;
let recordingChunks = [];
let isPlayingAudio = false;
let recordingStartTime = 0;
let currentSessionId = localStorage.getItem('kindergarten_session_id') || '';
let conversationStage = 'initial';
window.currentAudio = null;                         // グローバル変数

/* ───────── VAD 初期化 ───────── */
startVAD().catch(err=>{
  console.error(err);
  statusEl.textContent='❌ マイク使用不可';
});

async function startVAD(){
  statusEl.textContent='🎤 マイク準備中…';
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(micStream);
    const gain = audioCtx.createGain(); gain.gain.value=1.5;
    processor = audioCtx.createScriptProcessor(2048,1,1);
    processor.onaudioprocess = vadMonitor;
    src.connect(gain); gain.connect(processor); processor.connect(audioCtx.destination);

    mediaRecorder = new MediaRecorder(micStream,{mimeType:'audio/webm;codecs=opus'});
    mediaRecorder.ondataavailable = e=>recordingChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingStop;

    statusEl.textContent='🎧 どうぞお話しください…';
    vadActive=true;
    createQuickLinks();
  } catch (err) {
    console.error('マイク初期化エラー:', err);
    throw err;
  }
}

/* ───────── 発話検知 ───────── */
function vadMonitor(e){
  if(!vadActive||isPlayingAudio) return;
  const buf=e.inputBuffer.getChannelData(0);
  const vol=Math.sqrt(buf.reduce((s,x)=>s+x*x,0)/buf.length);
  if(vol>0.015){
    if(!speaking){
      speaking=true; statusEl.textContent='📢 発話中…';
      recordingChunks=[]; recordingStartTime=Date.now(); mediaRecorder.start();
    }
    clearTimeout(silenceTimer);
    silenceTimer=setTimeout(stopRecording,1300);
  }
}

function stopRecording(){
  if(mediaRecorder.state==='recording') mediaRecorder.stop();
  speaking=false; vadActive=false; statusEl.textContent='🧠 回答中…';
}

/* ───────── 修正: Whisper → GPT → TTS ───────── */
async function handleRecordingStop() {
  const blob = new Blob(recordingChunks, {type: 'audio/webm'});
  
  safeLog("録音Blobサイズ", blob.size);
  
  try {
    statusEl.textContent = '🧠 発話認識中…';
    
    // Base64エンコード処理
    const arrayBuffer = await blob.arrayBuffer();
    const base64Data = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (data, byte) => data + String.fromCharCode(byte), ''
      )
    );
    
    const duration = (Date.now() - recordingStartTime) / 1000;
    safeLog("音声データサイズ", Math.round(base64Data.length / 1024) + "KB");
    safeLog("録音時間", duration + "秒");
    
    // STTリクエスト送信
    safeLog("STTリクエスト送信開始", {
      endpoint: '/.netlify/functions/stt',
      format: 'audio/webm'
    });
    
    // STTリクエスト送信 (エラーハンドリング強化)
    let response;
    try {
      response = await fetch('/.netlify/functions/stt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          audio: base64Data,
          format: 'audio/webm',
          duration: duration
        })
      });
      
      safeLog("STTレスポンス受信", {
        status: response.status,
        statusText: response.statusText
      });
      
      if (!response.ok) {
        throw new Error(`STTサーバーエラー: ${response.status} ${response.statusText}`);
      }
      
      // レスポンスのJSONパース (エラーハンドリング強化)
      let sttResult;
      try {
        sttResult = await response.json();
        safeLog("STT結果(生データ)", sttResult);
      } catch (jsonError) {
        safeLog("JSONパースエラー", jsonError);
        throw new Error(`STTレスポンスのJSONパースに失敗: ${jsonError.message}`);
      }
      
      // データ構造の堅牢な検証
      if (!sttResult) {
        throw new Error("STTレスポンスが空です");
      }
      
      // エラーチェック
      if (sttResult.error) {
        safeLog("STTエラーレスポンス", sttResult.error);
        throw new Error(`音声認識エラー: ${sttResult.error}`);
      }
      
      // text プロパティの検証 (堅牢性向上)
      let recognizedText;
      
      // ケース1: 新しい構造 - { text: "...", originalText: "...", success: true }
      if (sttResult.text && typeof sttResult.text === 'string' && sttResult.text.trim()) {
        recognizedText = sttResult.text;
        safeLog("認識テキスト(直接プロパティ)", recognizedText);
      }
      // ケース2: 古い構造 - { stt: { text: "..." }, ... }
      else if (sttResult.stt && sttResult.stt.text && typeof sttResult.stt.text === 'string' && sttResult.stt.text.trim()) {
        recognizedText = sttResult.stt.text;
        safeLog("認識テキスト(sttプロパティ経由)", recognizedText);
      }
      // ケース3: その他の構造 または 空テキスト - エラー
      else {
        safeLog("無効なSTTレスポンス構造", {
          hasText: !!sttResult.text,
          textType: typeof sttResult.text,
          textEmpty: sttResult.text === '',
          hasStt: !!sttResult.stt,
          sttType: typeof sttResult.stt,
          allKeys: Object.keys(sttResult)
        });
        throw new Error("STTレスポンスに有効なテキストが含まれていません");
      }
      
      // テキスト処理と表示
      let fixedText = recognizedText.replace(/ご視聴ありがとうございました/g, 'ご回答ありがとうございました');
      recogEl.textContent = `お問合せ内容: ${fixedText}`;
      
      // AIへの処理を開始
      await handleAI(recognizedText);
    } catch (e) {
      safeLog("STT処理エラー", e);
      statusEl.textContent = '❌ 発話認識失敗: ' + (e.message || '不明なエラー');
      vadActive = true;
    }
  } catch (outerError) {
    safeLog('音声認識全体エラー', outerError);
    statusEl.textContent = '❌ 発話認識失敗';
    vadActive = true;
  }
}

async function handleAI(msg){
  try{
    statusEl.textContent='💭 回答生成中…';
    
    // 中間メッセージを表示
    showInterimMessage("しばらくお待ちください。");
    
    safeLog("AIリクエスト送信開始", { message: msg.substring(0, 50) + (msg.length > 50 ? "..." : "") });
    
    // AIリクエスト (エラーハンドリング強化)
    let aiResponse;
    try {
      const response = await fetch('/.netlify/functions/ai', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({message: msg, sessionId: currentSessionId})
      });
      
      safeLog("AIレスポンス受信", { status: response.status });
      
      if (!response.ok) {
        throw new Error(`AIサーバーエラー: ${response.status}`);
      }
      
      aiResponse = await response.json();
    } catch (aiError) {
      safeLog("AI通信エラー", aiError);
      throw new Error(`AI処理中にエラーが発生: ${aiError.message}`);
    }
    
    safeLog("AI結果", {
      hasReply: !!aiResponse.reply,
      sessionId: aiResponse.sessionId,
      stage: aiResponse.stage
    });
    
    // レスポンス検証
    if (!aiResponse || !aiResponse.reply) {
      throw new Error("AIからの応答が無効です");
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
    
    safeLog("TTSリクエスト送信開始", {
      textLength: aiResponse.reply.length,
      textPreview: aiResponse.reply.substring(0, 50) + (aiResponse.reply.length > 50 ? "..." : "")
    });
    
    // TTSリクエスト (エラーハンドリング強化)
    let ttsResponse;
    try {
      const response = await fetch('/.netlify/functions/tts', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text: aiResponse.reply})
      });
      
      safeLog("TTSレスポンス受信", { status: response.status });
      
      if (!response.ok) {
        throw new Error(`TTSサーバーエラー: ${response.status}`);
      }
      
      ttsResponse = await response.json();
    } catch (ttsError) {
      safeLog("TTS通信エラー", ttsError);
      throw new Error(`TTS処理中にエラーが発生: ${ttsError.message}`);
    }
    
    safeLog("TTS結果", {
      hasAudioUrl: !!ttsResponse.audioUrl,
      hasError: !!ttsResponse.error
    });
    
    // 音声URL検証と再生
    if (ttsResponse.audioUrl) {
      safeLog("音声URL取得成功", { urlPreview: ttsResponse.audioUrl.substring(0, 50) + "..." });
      
      try {
        await playAudio(ttsResponse.audioUrl);
        safeLog("音声再生完了", "再生完了");
      } catch (playError) {
        safeLog("音声再生エラー", playError);
        // 再生エラーは致命的ではないため、処理を続行
      }
    } else if (ttsResponse.error) {
      safeLog("TTS エラー", {
        error: ttsResponse.error,
        detail: ttsResponse.errorDetail || ""
      });
      // エラーがあってもテキスト応答は表示済みなので続行
    } else {
      safeLog("音声URLが見つかりません", ttsResponse);
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

/* ───────── 音声再生 - 進捗監視機能追加 ───────── */
function playAudio(url) {
  return new Promise((resolve, reject) => {
    try {
      safeLog("音声再生開始処理", { url: url.substring(0, 50) + "..." });
      
      // 既存の音声停止
      if (isPlayingAudio && window.currentAudio) {
        safeLog("既存の音声を停止", "停止処理");
        try {
          window.currentAudio.pause();
          window.currentAudio.src = ""; 
        } catch (pauseError) {
          safeLog("既存音声停止エラー", pauseError);
        }
        window.currentAudio = null;
        isPlayingAudio = false;
      }
      
      // 新しい音声オブジェクト作成
      window.currentAudio = new Audio();
      
      // 進捗監視のための変数
      let lastPosition = 0;
      let stagnantCount = 0;
      let progressTimer = null;
      
      // 再生進捗を監視する関数
      function startProgressMonitoring() {
        progressTimer = setInterval(() => {
          if (!window.currentAudio || !isPlayingAudio) return;
          
          try {
            // 現在の再生位置を取得
            const currentPosition = window.currentAudio.currentTime;
            
            // 位置が変わっていない場合
            if (currentPosition === lastPosition) {
              stagnantCount++;
              safeLog("再生位置が変わっていません", { 
                position: currentPosition, 
                count: stagnantCount 
              });
              
              // 3秒間位置が変わらなければ停止とみなす
              if (stagnantCount >= 3) {
                safeLog("再生停止を検出", "自動完了");
                clearInterval(progressTimer);
                isPlayingAudio = false;
                resolve();
              }
            } else {
              // 位置が変わっていればカウンターリセット
              stagnantCount = 0;
              lastPosition = currentPosition;
              safeLog("再生進行中", { position: currentPosition });
            }
          } catch (e) {
            safeLog("進捗監視エラー", e);
          }
        }, 1000);
      }
      
      // エラーハンドリング
      window.currentAudio.onerror = (e) => {
        if (progressTimer) clearInterval(progressTimer);
        safeLog("音声読み込みエラー", {
          code: window.currentAudio.error ? window.currentAudio.error.code : 'unknown',
          message: window.currentAudio.error ? window.currentAudio.error.message : 'unknown'
        });
        isPlayingAudio = false;
        reject(new Error("音声の読み込みに失敗しました"));
      };
      
      // 再生準備完了イベント
      window.currentAudio.oncanplaythrough = () => {
        safeLog("音声再生準備完了", "準備完了");
        isPlayingAudio = true;
        
        try {
          const playPromise = window.currentAudio.play();
          startProgressMonitoring(); // 進捗監視を開始
          
          if (playPromise !== undefined) {
            playPromise
              .then(() => safeLog("音声再生開始", "再生中"))
              .catch(err => {
                if (progressTimer) clearInterval(progressTimer);
                safeLog("音声再生Promise失敗", err);
                isPlayingAudio = false;
                reject(err);
              });
          } else {
            safeLog("音声再生開始 (Promiseなし)", "再生中");
          }
        } catch (playError) {
          if (progressTimer) clearInterval(progressTimer);
          safeLog("音声再生直接エラー", playError);
          isPlayingAudio = false;
          reject(playError);
        }
      };
      
      // 再生終了イベント
      window.currentAudio.onended = () => {
        if (progressTimer) clearInterval(progressTimer);
        safeLog("音声再生終了", "正常終了");
        isPlayingAudio = false;
        resolve();
      };
      
      // URL設定とロード開始
      window.currentAudio.src = url;
      window.currentAudio.load();
      
      // バックアップタイムアウト (180秒 = 3分)
      // 通常の回答でも十分な時間
      setTimeout(() => {
        if (isPlayingAudio) {
          if (progressTimer) clearInterval(progressTimer);
          safeLog("音声再生バックアップタイムアウト", "3分経過");
          try {
            window.currentAudio.pause();
          } catch (e) {
            safeLog("タイムアウト時の停止エラー", e);
          }
          isPlayingAudio = false;
          resolve();
        }
      }, 180000); // 3分
      
    } catch (e) {
      safeLog("playAudio関数内エラー", e);
      isPlayingAudio = false;
      reject(e);
    }
  });
}

/* ───────── クイックリンク & UI ───────── */
function createQuickLinks(){
  const arr=[
    '幼稚園の基本情報を教えてください',
    '入園の申し込みについて教えてください',
    '給食について教えてください',
    '保育時間について教えてください',
    '見学できますか？'
  ];
  quickLinksEl.innerHTML='';
  arr.forEach(t=>{
    const b=document.createElement('button'); b.textContent=t; b.className='ql';
    b.onclick=()=>{recogEl.textContent=`お問合せ内容: ${t}`; handleAI(t);};
    quickLinksEl.appendChild(b);
  });
}