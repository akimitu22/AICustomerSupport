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
    .replace(/https?:\/\/[^\s]+/g, 'ホームページのリンク');
}

// 電話番号をSSML形式に変換
function formatPhoneNumbers(text) {
  // 電話番号のパターン (例: 048-555-2301)
  return text.replace(
    /(\d{2,4})[-\s]?(\d{2,4})[-\s]?(\d{2,4})/g, 
    '<say-as interpret-as="telephone">$1-$2-$3</say-as>'
  );
}

// 句読点での自然なポーズを追加
function addPauses(text) {
  return text
    .replace(/([。、．，！？])\s*/g, '$1<break time="300ms"/>')
    .replace(/\n+/g, '<break time="500ms"/>');
}

// テキストをSSMLに変換（完全版）
function textToSSML(text) {
  let ssml = text;
  
  // マークダウンをSSMLに変換
  ssml = convertMarkdownToSSML(ssml);
  
  // 電話番号をSSMLタグで囲む
  ssml = formatPhoneNumbers(ssml);
  
  // 句読点での自然なポーズを追加
  ssml = addPauses(ssml);
  
  return `<speak>${ssml}</speak>`;
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
        voice: { 
          languageCode: 'ja-JP', 
          name: 'ja-JP-Standard-B'
        },
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15
        },
      };
    } else {
      // 通常のテキスト入力の前処理
      let processedText = text;
      
      // 日本語の読み最適化
      processedText = optimizeJapaneseReading(processedText);
      
      // URLを読みやすくする
      processedText = optimizeUrlsForSpeech(processedText);
      
      // SSMLに変換（マークダウン、電話番号、ポーズなど）
      const processedSSML = textToSSML(processedText);
      
      requestBody = {
        input: { ssml: processedSSML },
        voice: { 
          languageCode: 'ja-JP', 
          name: 'ja-JP-Standard-B'
        },
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15
        },
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