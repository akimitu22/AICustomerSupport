/* ─────────────────────────────────────
   client.js  ―  音声録音・GPT連携・TTS再生
   ───────────────────────────────────── */
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
let currentAudio = null;

/* ───────── VAD 初期化 ───────── */
startVAD().catch(err=>{
  console.error(err);
  statusEl.textContent='❌ マイク使用不可';
});

async function startVAD(){
  statusEl.textContent='🎤 マイク準備中…';
  micStream = await navigator.mediaDevices.getUserMedia({
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
  });
  audioCtx   = new (window.AudioContext||window.webkitAudioContext)();
  const src  = audioCtx.createMediaStreamSource(micStream);
  const gain = audioCtx.createGain(); gain.gain.value=1.5;
  processor  = audioCtx.createScriptProcessor(2048,1,1);
  processor.onaudioprocess = vadMonitor;
  src.connect(gain); gain.connect(processor); processor.connect(audioCtx.destination);

  mediaRecorder = new MediaRecorder(micStream,{mimeType:'audio/webm;codecs=opus'});
  mediaRecorder.ondataavailable = e=>recordingChunks.push(e.data);
  mediaRecorder.onstop = handleRecordingStop;

  statusEl.textContent='🎧 どうぞお話しください…';
  vadActive=true;
  createQuickLinks();
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

/* ───────── Whisper → GPT → TTS ───────── */
async function handleRecordingStop(){
  const blob = new Blob(recordingChunks,{type:'audio/webm'});
  const fd=new FormData();
  fd.append('audio',blob,'audio.webm');
  fd.append('duration',((Date.now()-recordingStartTime)/1000).toString());

  try{
    statusEl.textContent='🧠 発話認識中…';
    // APIパスを変更:
    const stt=await fetch('/.netlify/functions/stt',{method:'POST',body:fd}).then(r=>r.json());
    if(!stt.text?.trim()){statusEl.textContent='❌ 発話認識失敗'; vadActive=true; return;}
    let fixedText = stt.text.replace(/ご視聴ありがとうございました/g, 'ご回答ありがとうございました');
    recogEl.textContent = `お問合せ内容: ${fixedText}`;
    await handleAI(stt.text);
  }catch(e){
    console.error(e); statusEl.textContent='❌ 発話認識失敗'; vadActive=true;
  }
}

async function handleAI(msg){
  try{
    statusEl.textContent='💭 回答生成中…';
    // APIパスを変更:
    const ai=await fetch('/.netlify/functions/ai',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:msg,sessionId:currentSessionId})
    }).then(r=>r.json());

    currentSessionId=ai.sessionId;
    localStorage.setItem('kindergarten_session_id',currentSessionId);
    conversationStage=ai.stage;

    setTimeout(()=>{replyEl.textContent=`サポートからの回答: ${ai.reply}`;},500);

    statusEl.textContent='🔊 回答生成中…';
    // APIパスを変更:
    const tts=await fetch('/.netlify/functions/tts',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({text:ai.reply})
    }).then(r=>r.json());

    if(tts.audioUrl) await playAudio(tts.audioUrl);
  }catch(e){
    console.error(e); statusEl.textContent='❌ 回答生成失敗';
  }finally{
    vadActive=true; statusEl.textContent='🎧 次の発話を検知します';
  }
}

function playAudio(url){
  return new Promise(res=>{
    if(isPlayingAudio&&currentAudio) currentAudio.pause();
    currentAudio=new Audio(url); isPlayingAudio=true; currentAudio.play();
    currentAudio.onended=()=>{isPlayingAudio=false; res();};
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