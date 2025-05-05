// netlify/functions/tts/index.js
// 安定版：Base64・JSON・ファイルパスすべて対応、遅延初期化対応済み

const textToSpeech = require('@google-cloud/text-to-speech');

/* ───── 発音補正辞書 ───── */
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

/* ───── Google TTS クライアント遅延初期化 ───── */
let ttsClient = null;

function initTTSClient() {
  const envVars = [
    'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CREDENTIALS',
    'GCP_CREDENTIALS'
  ];

  for (const key of envVars) {
    const raw = process.env[key];
    if (!raw) continue;

    // JSON 文字列
    if (raw.trim().startsWith('{')) {
      return new textToSpeech.TextToSpeechClient({ credentials: JSON.parse(raw) });
    }

    // Base64 → JSON
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      if (decoded.trim().startsWith('{')) {
        return new textToSpeech.TextToSpeechClient({ credentials: JSON.parse(decoded) });
      }
    } catch (_) {
      /* ignore */
    }

    // ファイルパスとして利用
    return new textToSpeech.TextToSpeechClient({ keyFilename: raw });
  }

  throw new Error(
    'Google認証情報が不正または未設定です。Netlifyの環境変数にJSONまたはBase64を指定してください。'
  );
}

function getTTSClient() {
  if (!ttsClient) {
    ttsClient = initTTSClient();
  }
  return ttsClient;
}

/* ───── Lambda ハンドラ ───── */
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };

  // OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'JSONパースエラー', details: e.message })
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

  const fixedText = fixPronunciation(text);
  const ssml = `<speak>${fixedText}</speak>`;

  try {
    const [resp] = await getTTSClient().synthesizeSpeech({
      input: { ssml },
      voice: { languageCode: 'ja-JP', name: 'ja-JP-Neural2-B' },
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.15 }
    });

    const base64 = Buffer.from(resp.audioContent).toString('base64');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        audioUrl: `data:audio/mpeg;base64,${base64}`
      })
    };
  } catch (e) {
    console.error('TTS 呼び出し失敗:', e);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: 'Google TTS 呼び出し失敗',
        details: e.message,
        fallbackText: fixedText
      })
    };
  }
};
