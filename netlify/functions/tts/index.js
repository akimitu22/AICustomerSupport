// netlify/functions/tts/index.js
const fetch = require('node-fetch');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // ─ OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  try {
    const requestData = JSON.parse(event.body || '{}');
    const { text = '', ssml = '' } = requestData;
    
    if (!text.trim() && !ssml.trim()) {
      throw new Error('text is empty');
    }

    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY not set');

    /* ── Google TTS ── */
    let requestBody;
    
    if (ssml && ssml.trim()) {
      // SSMLが提供されている場合はそれを使用
      requestBody = {
        input: { ssml: ssml.includes('<speak>') ? ssml : `<speak>${ssml}</speak>` },
        voice: { languageCode: 'ja-JP', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      };
    } else {
      // 通常のテキスト入力
      requestBody = {
        input: { text },
        voice: { languageCode: 'ja-JP', ssmlGender: 'NEUTRAL' },
        audioConfig: { audioEncoding: 'MP3' },
      };
    }

    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      }
    ).then(r => r.json());

    if (!resp.audioContent) throw new Error(resp.error?.message || 'no audio');

    /* ─ data:URL にラップ ─ */
    const audioUrl = `data:audio/mpeg;base64,${resp.audioContent}`;

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioUrl }),
    };
  } catch (err) {
    console.error('TTS error:', err);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'TTS failed', detail: err.message }),
    };
  }
};