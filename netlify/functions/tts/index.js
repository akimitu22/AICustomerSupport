// netlify/functions/tts/index.js
// 2025-05-06 版  ─ GOOGLE_APPLICATION_CREDENTIALS が
//   ① Base64 エンコード JSON
//   ② そのままの JSON
//   ③ ファイルパス              の 3 形態すべてに対応。
// ---------------------------------------------

const textToSpeech = require('@google-cloud/text-to-speech');

/* ───── 1. 読み替え辞書 ───── */
const pronunciationDictionary = {
  '副園長': 'ふくえんちょう',
  '入園':   'にゅうえん',
  '園長':   'えんちょう',
  '幼稚園': 'ようちえん',
  '園庭':   'えんてい',
  '園児':   'えんじ',
  '他園':   'たえん',
  '園':     'えん'
};
function fixPronunciation(text = '') {
  let out = text;
  for (const [word, kana] of Object.entries(pronunciationDictionary)) {
    out = out.replace(new RegExp(word, 'g'), kana);
  }
  return out;
}

/* ───── 2. Google TTS クライアント初期化 ───── */
function initTTSClient() {
  const candKeys = [
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CREDENTIALS',
    'GCP_CREDENTIALS'
  ];

  for (const key of candKeys) {
    const raw = process.env[key];
    if (!raw) continue;

    // 2-1) そのまま JSON 文字列
    if (raw.trim().startsWith('{')) {
      return new textToSpeech.TextToSpeechClient({ credentials: JSON.parse(raw) });
    }

    // 2-2) Base64 → JSON
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (decoded.trim().startsWith('{')) {
        return new textToSpeech.TextToSpeechClient({ credentials: JSON.parse(decoded) });
      }
    } catch (_) {
      /* fall through */
    }

    // 2-3) ファイルパス
    return new textToSpeech.TextToSpeechClient({ keyFilename: raw });
  }

  throw new Error(
    'Google Cloud 認証情報が見つかりません。' +
    'Netlify の環境変数に JSON または Base64 文字列を設定してください。'
  );
}

let ttsClient;   // ランタイムで 1 回だけ初期化
try   { ttsClient = initTTSClient(); }
catch (e) { console.error('TTS Client 初期化失敗:', e); }

/* ───── 3. Lambda ハンドラ ───── */
exports.handler = async (event) => {
  const allowHeaders = [
    'Content-Type',
    'Authorization'
  ].join(', ');

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': allowHeaders
  };

  /* ── CORS プリフライト ── */
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  /* ── リクエスト解析 ── */
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'JSON パースエラー', details: e.message })
    };
  }

  const text = body.text?.trim();
  if (!text) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'テキストが空です' })
    };
  }

  /* ── 発音補正 & SSML ── */
  const fixed   = fixPronunciation(text);
  const ssml    = `<speak>${fixed}</speak>`;

  /* ── Google TTS 呼び出し ── */
  try {
    const [resp] = await ttsClient.synthesizeSpeech({
      input: { ssml },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
    });

    const base64 = Buffer.from(resp.audioContent).toString('base64');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ audioUrl: `data:audio/mpeg;base64,${base64}` })
    };
  } catch (e) {
    console.error('TTS API エラー:', e);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Google TTS 呼び出し失敗',
        details: e.message,
        fallbackText: fixed
      })
    };
  }
};
