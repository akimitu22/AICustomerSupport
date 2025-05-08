// netlify/functions/stt/index.js
const axios = require('axios');
const FormData = require('form-data');

/* ───────── 誤変換辞書 ───────── */
const speechCorrectionDict = {
  /* ホザナ幼稚園 */
  'おだな幼稚園': 'ホザナ幼稚園',
  'おさない幼稚園': 'ホザナ幼稚園',
  '幼い幼稚園':   'ホザナ幼稚園',
  '小棚幼稚園':   'ホザナ幼稚園',
  '児玉幼稚園':   'ホザナ幼稚園',

  /* 預かり保育 */
  'あつかいほいく': '預かり保育',
  'あつがりほいく': '預かり保育',
  '扱い保育':       '預かり保育',
  '暑がり保育':     '預かり保育',

  /* 願書 */
  'がんしょう': '願書',
  'かんしょう': '願書',
  '干渉':       '願書',
  '眼症':       '願書',
  '顔症':       '願書',
  '元祥':       '願書',
  'がんしょ':   '願書',
  'かんしょ':   '願書',
  '幹書':       '願書',
  'みきしょ':   '願書',

  /* モンテッソーリゆれ & 誤認識 */
  'モンテストーリー':       'モンテッソーリ',
  'モンテストーリー教育':   'モンテッソーリ教育',
  'モンテソーリ':           'モンテッソーリ',
  'モンテソリー':           'モンテッソーリ',
  'マンテッソーリ':         'モンテッソーリ',
  'モンテッソリ':           'モンテッソーリ',

  /* その他 */
  '講演':       '降園'
  '登演':       '登園'
};

/* ───────── Whisper 用プロンプト ───────── */
const KINDERGARTEN_PROMPT =
  '===== 音声認識コンテキスト：ホザナ幼稚園 入園案内 =====\n' +
  'この会話はホザナ幼稚園の入園手続き・モンテッソーリ教育に関する Q&A です。\n\n' +
  '===== 用語ガイド =====\n' +
  '・「ホザナ幼稚園」は固有名詞です（誤認例: おだな／おさない）。\n' +
  '・「預かり保育」は園のサービス名です（誤認例: あつかりほいく）。\n' +
  '・「願書」は入園書類名です（誤認例: がんしょう）。\n' +
  '・「モンテッソーリ教育」は頻出教育法です（誤認例: モンテストーリー）。\n\n' +
  '===== 出力上の禁止事項 =====\n' +
  '※ 出力テキストに【名前】のような話者ラベルや Speaker タグを付けないでください。\n';

/* ───────── 前処理：話者ラベル除去 ───────── */
function stripSpeakerLabel(text) {
  return text.replace(
    /^\s*(?:【[^】]{1,12}】|\[[^\]]{1,12}\]|\([^\)]{1,12}\)|[^\s]{1,12}[：:])\s*/u,
    ''
  );
}

/* ───────── 誤変換補正 ───────── */
function correctKindergartenTerms(text) {
  let corrected = text;

  /* 基本辞書置換 */
  for (const [wrong, right] of Object.entries(speechCorrectionDict)) {
    corrected = corrected.replace(new RegExp(wrong, 'g'), right);
  }

  /* 円⇄園 誤変換 */
  corrected = corrected
    .replace(/(\d+)([万千百十]?)円/g, '$1$2円')          // 数字＋円はそのまま
    .replace(/([^\d０-９万千百十])円/g, '$1園');            // それ以外＋円→園

  /* しますから？→しますか？ */
  corrected = corrected.replace(/しますから\?/g, 'しますか?');

  /* ひらがなの ようちえん → 幼稚園 */
  corrected = corrected.replace(/ようちえん/g, '幼稚園');

  return corrected;
}

/* ───────── Whisper API 呼び出し ───────── */
async function callWhisperAPI(audioBuffer, format) {
  const formData = new FormData();
  formData.append('file', audioBuffer, {
    filename: 'audio.webm',
    contentType: format || 'audio/webm'
  });
  formData.append('model', 'whisper-1');
  formData.append('prompt', KINDERGARTEN_PROMPT);

  const headers = formData.getHeaders();
  headers['Content-Length'] = await new Promise(res =>
    formData.getLength((_, len) => res(len))
  );

  return axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...headers },
    maxBodyLength: 25 * 1024 * 1024,
    maxContentLength: 25 * 1024 * 1024,
    timeout: 25000
  });
}

/* ───────── 共通レスポンス整形 ───────── */
function formatResponse(statusCode, headers, data = {}, error = null) {
  const body = { success: statusCode >= 200 && statusCode < 300, ...data };
  if (error) body.error = error;
  if (!body.text && body.stt?.text) body.text = body.stt.text;
  if (!body.text?.trim()) {
    body.success = false;
    body.error = body.error || '認識されたテキストが空です';
    body.text = '認識エラー';
    statusCode = 422;
  }
  return { statusCode, headers, body: JSON.stringify(body) };
}

/* ───────── Lambda ハンドラ ───────── */
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return formatResponse(405, headers, {}, 'Method Not Allowed');

  try {
    if (!event.headers['content-type']?.includes('application/json'))
      return formatResponse(400, headers, {}, 'JSON required');

    const req = JSON.parse(event.body || '{}');
    if (!req.audio) return formatResponse(400, headers, {}, 'No audio data');
    if (!process.env.OPENAI_API_KEY) return formatResponse(500, headers, {}, 'API key missing');

    /* 音声サイズ検証 */
    const audioBuffer = Buffer.from(req.audio, 'base64');
    if (audioBuffer.length / (1024 * 1024) > 9.5)
      return formatResponse(413, headers, {}, 'Audio too large (>10 MB)');

    /* Whisper 呼び出し */
    const resp = await callWhisperAPI(audioBuffer, req.format);
    let recognized = resp.data.text || '';
    recognized = stripSpeakerLabel(recognized);        // ← 話者ラベルを除去
    const corrected = correctKindergartenTerms(recognized);

    return formatResponse(200, headers, {
      text: corrected,
      originalText: recognized,
      timestamp: Date.now()
    });

  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || err.message;
    return formatResponse(status, headers, { details: detail }, 'Whisper API error');
  }
};
