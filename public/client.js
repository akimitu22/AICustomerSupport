let micStream, audioContext, mediaRecorder;
let recordingChunks = [];
let silenceTimer, speaking = false, vadActive = false;
let recordingStartTime = 0;
let currentSessionId = null;
let currentAudio = null;
let isPlayingAudio = false;
let conversationStage = 0;

const statusEl = document.getElementById('status');
const recogEl = document.getElementById('recog');
const replyEl = document.getElementById('reply');
const quickLinksEl = document.getElementById('quick-links');

document.getElementById('start').onclick = initMic;

async function initMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();

    const source = audioContext.createMediaStreamSource(micStream);
    const processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = vadMonitor;
    source.connect(processor);
    processor.connect(audioContext.destination);

    mediaRecorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorder.ondataavailable = e => recordingChunks.push(e.data);
    mediaRecorder.onstop = handleRecordingStop;

    statusEl.textContent = '🎧 どうぞお話しください…';
    vadActive = true;
    createQuickLinks();
  } catch (e) {
    console.error('マイク初期化エラー:', e);
    statusEl.textContent = '❌ マイクを初期化できませんでした';
  }
}

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
    }
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(stopRecording, 1300);
  }
}

function stopRecording() {
  if (mediaRecorder.state === 'recording') mediaRecorder.stop();
  speaking = false;
  vadActive = false;
  statusEl.textContent = '🧠 回答中…';
}

async function handleRecordingStop() {
  const blob = new Blob(recordingChunks, { type: 'audio/webm' });

  try {
    statusEl.textContent = '🧠 発話認識中…';

    const arrayBuffer = await blob.arrayBuffer();
    const base64Data = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    console.log("音声データサイズ: " + Math.round(base64Data.length / 1024) + "KB");

    const stt = await fetch('/.netlify/functions/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio: base64Data,
        format: 'audio/webm',
        duration: (Date.now() - recordingStartTime) / 1000
      })
    }).then(r => {
      console.log("STTレスポンス受信: ステータス", r.status);
      return r.json();
    });

    console.log("STT結果:", stt);

    if (!stt.text?.trim()) {
      console.error("STT結果が空です");
      statusEl.textContent = '❌ 発話認識失敗';
      vadActive = true;
      return;
    }

    let fixedText = stt.text.replace(/ご視聴ありがとうございました/g, 'ご回答ありがとうございました');
    recogEl.textContent = `お問合せ内容: ${fixedText}`;
    await handleAI(stt.text);
  } catch (e) {
    console.error('音声認識エラー:', e);
    statusEl.textContent = '❌ 発話認識失敗';
    vadActive = true;
  }
}

async function handleAI(msg) {
  try {
    statusEl.textContent = '💭 回答生成中…';

    console.log("AIリクエスト送信開始:", msg);
    const ai = await fetch('/.netlify/functions/ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, sessionId: currentSessionId })
    }).then(r => {
      console.log("AIレスポンス受信: ステータス", r.status);
      return r.json();
    });

    console.log("AI結果:", ai);

    currentSessionId = ai.sessionId;
    localStorage.setItem('kindergarten_session_id', currentSessionId);
    conversationStage = ai.stage;

    setTimeout(() => { replyEl.textContent = `サポートからの回答: ${ai.reply}`; }, 500);

    statusEl.textContent = '🔊 回答生成中…';

    console.log("TTSリクエスト送信開始:", ai.reply.substring(0, 50) + ".");
    const tts = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ai.reply })
    }).then(r => {
      console.log("TTSレスポンス受信: ステータス", r.status);
      return r.json();
    });

    console.log("TTS結果:", tts);

    if (tts.audioUrl) {
      console.log("音声URL取得成功、再生開始:", tts.audioUrl.substring(0, 50) + ".");
      try {
        await playAudio(tts.audioUrl);
        console.log("音声再生完了");
      } catch (playError) {
        console.error("音声再生エラー:", playError);
      }
    } else if (tts.error) {
      console.error("TTS エラー:", tts.error, tts.errorDetail || "");
    } else {
      console.error("音声URLが見つかりません:", tts);
    }
  } catch (e) {
    console.error('AI/TTS処理エラー:', e);
    statusEl.textContent = '❌ 回答生成失敗';
  } finally {
    vadActive = true;
    statusEl.textContent = '🎧 次の発話を検知します';
  }
}

function playAudio(url) {
  console.log("playAudio関数が呼び出されました");
  return new Promise((resolve, reject) => {
    try {
      if (isPlayingAudio && currentAudio) {
        console.log("既存の音声を停止");
        currentAudio.pause();
      }

      currentAudio = new Audio(url);
      console.log("Audioオブジェクト作成完了");

      currentAudio.onerror = (e) => {
        console.error("音声読み込みエラー:", e);
        reject(new Error("音声の読み込みに失敗しました"));
      };

      currentAudio.oncanplaythrough = () => {
        console.log("音声再生準備完了");
        isPlayingAudio = true;

        console.log("ブラウザ音声状態:", "ミュート=", currentAudio.muted, "ボリューム=", currentAudio.volume);

        const playPromise = currentAudio.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => console.log("音声再生開始"))
            .catch(err => {
              console.error("音声再生Promise失敗:", err);
              reject(err);
            });
        }
      };

      currentAudio.onended = () => {
        console.log("音声再生終了");
        isPlayingAudio = false;
        resolve();
      };
    } catch (e) {
      console.error("playAudio関数内エラー:", e);
      reject(e);
    }
  });
}

function createQuickLinks() {
  const arr = [
    '幼稚園の基本情報を教えてください',
    '入園の申し込みについて教えてください',
    '給食について教えてください',
    '保育時間について教えてください',
    '見学できますか？'
  ];
  quickLinksEl.innerHTML = '';
  arr.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t;
    b.className = 'ql';
    b.onclick = () => { recogEl.textContent = `お問合せ内容: ${t}`; handleAI(t); };
    quickLinksEl.appendChild(b);
  });
}
