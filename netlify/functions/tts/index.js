// netlify/functions/tts/index.js
const fetch = require('node-fetch');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 日本語の読み最適化
function optimizeJapaneseReading(text) {
  return text
    .replace(/副園長/g, 'ふくえんちょう')
    .replace(/入園/g, 'にゅうえん')
    .replace(/園長/g, 'えんちょう')
    .replace(/幼稚園/g, 'ようちえん')
    .replace(/園庭/g, 'えんてい')
    .replace(/園児/g, 'えんじ')
    .replace(/他園/g, 'たえん')
    .replace(/園/g, 'えん')
    .replace(/大坪園子/g, 'おおつぼそのこ');
}

// マークダウンをシンプルテキストに変換
function cleanMarkdown(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1');
}

// URLを読みやすくする
function optimizeUrlsForSpeech(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク');
}

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
      // 通常のテキスト入力の前処理
      let processedText = text;
      
      // 前処理を適用
      processedText = optimizeJapaneseReading(processedText);
      processedText = cleanMarkdown(processedText);
      processedText = optimizeUrlsForSpeech(processedText);
      
      requestBody = {
        input: { text: processedText },
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