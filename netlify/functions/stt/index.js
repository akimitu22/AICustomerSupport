// netlify/functions/stt/index.js
const axios = require('axios');
const FormData = require('form-data');
const kanjiDict = require('./stt-kanji-dictionary.json');

// 幼稚園関連の音声認識向上のための特別プロンプト
const KINDERGARTEN_PROMPT = 
  '===== 音声認識コンテキスト：幼稚園入園案内 =====\n' +
  '「ホザナ幼稚園」の入園手続きに関する会話です。\n\n' +
  '===== 重要な音声パターン認識 =====\n' + 
  '・「ほざな」[HOZANA] - 幼稚園名の固有発音\n' +
  '  誤認識されやすい音声：「おだな」「ほさない」「おさない」「おざわ」「ほたな」\n' +
  '・「あずかりほいく」[AZUKARI-HOIKU] - 重要サービス名\n' +
  '  誤認識されやすい音声：「あつかい」「とりあつかい」「あつかいほいく」\n' +
  '・「がんしょ」[GANSHO] - 重要書類名\n' +
  '  誤認識されやすい音声：「がんしょう」「かんしょ」「かんじょう」\n\n' +
  '===== 音声パターンの文脈 =====\n' + 
  '・「ほざな」は必ず「ようちえん」と一緒に使われる重要な固有名詞です\n' + 
  '・幼稚園名が「おだな」「ほさない」などと認識された場合は「ほざな」に修正してください\n' + 
  '・入園手続きの文脈で「がんしょう」などと認識された場合は「がんしょ」（願書）に修正してください\n' +
  '・「あずかり」と「ほいく」は一つの概念として扱ってください\n' + 
  '・この会話は幼稚園関連の用語のみを使用します';

/**
 * 幼稚園関連の誤変換補正を実行する関数
 * @param {string} text - 音声認識された生テキスト
 * @returns {string} - 補正されたテキスト
 */
function correctKindergartenTerms(text) {
  let corrected = text;
  
  // 辞書ベースの置換（基本的な誤変換修正）
  Object.entries(kanjiDict).forEach(([key, val]) => {
    corrected = corrected.replace(new RegExp(key, 'g'), val);
  });
  
  // 固有名詞の特別補正（複合パターン）
  // ホザナ幼稚園の誤認識パターン
  corrected = corrected.replace(
    /(おだな|ほさない|おさない|おざわ|ほたな|児玉|小棚|幼い)(幼稚園|ようちえん)/g, 
    'ホザナ$2'
  );
  
  // 預かり保育の誤認識パターン
  corrected = corrected.replace(
    /(あつかい|とりあつかい|扱い)(保育|ほいく)/g, 
    '預かり$2'
  );
  
  // 願書の誤認識パターン
  corrected = corrected.replace(
    /(がんしょう|かんしょ|かんじょう|顔症)/g, 
    '願書'
  );
  
  // 文脈による修正（より高度な誤認識補正）
  // ようちえん → 幼稚園
  corrected = corrected.replace(/ようちえん/g, '幼稚園');
  
  // 円→園の特殊変換（前後の文脈を考慮）
  corrected = corrected.replace(/(\d+)([万千百十]?)円/g, '$1$2円'); // 数字+円はそのまま
  corrected = corrected.replace(/([^\d０-９万千百十])円/g, '$1園'); // 数字以外+円は園に変換
  
  return corrected;
}

/**
 * Whisper APIに音声データを送信する関数
 * @param {Buffer} audioBuffer - 音声データのバッファ
 * @param {string} format - 音声フォーマット
 * @returns {Promise<Object>} - Whisper APIのレスポンス
 */
async function callWhisperAPI(audioBuffer, format) {
  const formData = new FormData();
  
  formData.append('file', audioBuffer, {
    filename: 'audio.webm',
    contentType: format || 'audio/webm'
  });
  
  formData.append('model', 'whisper-1');
  formData.append('prompt', KINDERGARTEN_PROMPT);
  
  const formHeaders = formData.getHeaders();
  formHeaders['Content-Length'] = await new Promise(resolve =>
    formData.getLength((err, len) => resolve(len))
  );
  
  return axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    formData,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formHeaders
      },
      maxBodyLength: 25 * 1024 * 1024,
      maxContentLength: 25 * 1024 * 1024,
      timeout: 25000
    }
  );
}

// メインハンドラー関数
exports.handler = async function(event, context) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  // OPTIONS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: "" };
  }

  // only POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  console.log("STT start");
  console.log("isBase64Encoded:", event.isBase64Encoded);

  try {
    // リクエストの検証
    const contentType = event.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "JSON required", success: false })
      };
    }

    let req;
    try {
      req = JSON.parse(event.body || '{}');
    } catch (e) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "JSON parse error", details: e.message, success: false })
      };
    }

    if (!req.audio) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "No audio data", success: false })
      };
    }

    if (!process.env.OPENAI_API_KEY) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: "API key missing", success: false })
      };
    }

    // 音声データの準備と検証
    console.log("Audio length:", req.audio.length);
    console.log("Format:", req.format);
    
    const audioBuffer = Buffer.from(req.audio, 'base64');
    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > 9.5) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: "Audio too large (>10MB)", success: false })
      };
    }

    // Whisper APIを呼び出し
    console.log("Calling Whisper API");
    const resp = await callWhisperAPI(audioBuffer, req.format);
    console.log("Whisper status:", resp.status);

    // 音声認識結果の補正処理
    let recognizedText = resp.data.text || '';
    let correctedText = correctKindergartenTerms(recognizedText);
    
    // 入力と修正結果が異なる場合はログ出力
    if (recognizedText !== correctedText) {
      console.log("Text correction applied:");
      console.log("Before:", recognizedText);
      console.log("After:", correctedText);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        text: correctedText, 
        originalText: recognizedText,
        success: true 
      })
    };

  } catch (error) {
    console.error("STT error:", error);
    if (error.stack) console.error(error.stack);
    
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      return {
        statusCode: 504,
        headers,
        body: JSON.stringify({ error: "Timeout", details: error.message, success: false })
      };
    }
    
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    return {
      statusCode: status,
      headers,
      body: JSON.stringify({ error: "Whisper API error", details: detail, success: false })
    };
  }
};