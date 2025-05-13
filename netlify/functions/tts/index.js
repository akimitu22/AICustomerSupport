// netlify/functions/tts/index.js
import fetch from 'node-fetch';

// JSONファイルを動的にインポート
import kindergartenQAData from './QandA.json' assert { type: 'json' };
const kindergartenQA = kindergartenQAData.kindergartenQA;

// 追加するプロンプト情報（実装と連携）
const TTS_PROMPT = {
  instructions: `
    テキスト読み上げに関する指示:
    - 園の名前は「ホザナようちえん」と読む
    - 電話番号は読み上げない
    - 「副園長」は必ず「ふくえんちょう」と読み、「ふくえんまち」とは読まない
    - 「園児数」は必ず「えんじすう」と読み、決して「えんじかず」と読まない
    - 「総園児数」は必ず「そうえんじすう」と読む
  `
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// 日本語の読み最適化（TTS_PROMPTに基づく実装）
function optimizeJapaneseReading(text) {
  // プロンプトの指示を実装
  return text
    .replace(/副園長/g, 'ふくえんちょう')
    .replace(/入園/g, 'にゅうえん')
    .replace(/登園/g, 'とうえん')
    .replace(/降園/g, 'こうえん')
    .replace(/通園/g, 'つうえん')
    .replace(/他園/g, 'たえん')
    .replace(/卒園/g, 'そつえん')
    .replace(/卒園児/g, 'そつえんじ')
    .replace(/園児数/g, 'えんじすう')     
    .replace(/総園児数/g, 'そうえんじすう') 
    .replace(/園児/g, 'えんじ')
    .replace(/園/g, 'えん');
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

// 電話番号をSSML形式に変換（プロンプト指示: 電話番号は読み上げない）
function formatPhoneNumbers(text) {
  // 電話番号を検出して無音に置き換え
  return text.replace(
    /(\d{2,4})[-\s]?(\d{2,4})[-\s]?(\d{2,4})/g, 
    '<break time="300ms"/>' // プロンプト指示に基づき無音に置き換え
  );
}

// ポーズと抑揚を追加
function addProsody(text) {
  return text
    .replace(/([。、．，！？])\s*/g, '$1<break time="300ms"/>')
    .replace(/\n+/g, '<break time="500ms"/>');
}

// テキストをSSMLに変換（統合関数）
function textToSSML(text) {
  // プロンプト指示に従った変換処理を実行
  let ssml = optimizeJapaneseReading(text);
  ssml = cleanMarkdown(ssml);
  ssml = optimizeUrlsForSpeech(ssml);
  ssml = formatPhoneNumbers(ssml);
  ssml = addProsody(ssml);
  
  // 数字の読み上げ最適化（プロンプト指示: 数字は適切に読み上げる）
  // SSMLの特性で、基本的な数字の読み上げはGoogle TTSが自動対応
  
  return `<speak>${ssml}</speak>`;
}

export const handler = async (event) => {
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
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        },
      };
    } else {
      // 通常のテキスト入力の前処理（プロンプト指示に基づく）
      const processedSSML = textToSSML(text);
      
      requestBody = {
        input: { ssml: processedSSML },
        voice: { languageCode: 'ja-JP', ssmlGender: 'NEUTRAL' },
        audioConfig: { 
          audioEncoding: 'MP3',
          speakingRate: 1.15,
          pitch: 0.0,
          volumeGainDb: 0.0
        },
      };
    }

    // モデル選択を試行
    try {
      requestBody.voice.name = 'ja-JP-Standard-B';
    } catch (e) {
      console.log('Voice model specification failed, using default voice');
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