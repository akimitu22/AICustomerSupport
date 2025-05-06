// netlify/functions/tts/index.js
const fetch = require('node-fetch');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 日本語の読み方最適化
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

// マークダウンをSSMLに変換
function convertMarkdownToSSML(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '<emphasis level="moderate">$1</emphasis>')
    .replace(/\*(.+?)\*/g, '<emphasis level="reduced">$1</emphasis>')
    .replace(/__(.+?)__/g, '<emphasis level="strong">$1</emphasis>');
}

// URLを読みやすくする
function optimizeUrlsForSpeech(text) {
  return text
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク')
    .replace(/(?<=\d{2,3})[-\s]?(?=\d{2,4})[-\s]?(?=\d{4})/g, ' ');
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
      throw new Error('text or ssml is required');
    }

    const key = process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GOOGLE_API_KEY not set');

    // 入力がSSMLかテキストかを決定
    let finalInput = {};
    
    if (ssml && ssml.trim()) {
      // すでにSSMLが提供されている場合
      finalInput = { ssml: ssml.includes('<speak>') ? ssml : `<speak>${ssml}</speak>` };
    } else {
      // テキストからSSMLを生成
      const optimizedText = optimizeJapaneseReading(text);
      const cleanedText = optimizeUrlsForSpeech(optimizedText);
      const ssmlText = convertMarkdownToSSML(cleanedText);
      finalInput = { ssml: `<speak>${ssmlText}</speak>` };
    }

    // Google Cloud TTS APIリクエスト
    const resp = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: finalInput,
          voice: { 
            languageCode: 'ja-JP', 
            name: 'ja-JP-Neural2-B', // 旧実装互換の音声モデル
            ssmlGender: 'NEUTRAL' 
          },
          audioConfig: { 
            audioEncoding: 'MP3',
            speakingRate: 1.15, // 旧実装互換の速度
            pitch: 0.0
          },
        }),
      }
    ).then(r => r.json());

    if (!resp.audioContent) {
      throw new Error(resp.error?.message || 'Failed to generate audio');
    }

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
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'TTS failed', detail: err.message }),
    };
  }
};