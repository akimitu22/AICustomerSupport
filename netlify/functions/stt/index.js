// netlify/functions/stt/index.js
const axios = require('axios');
const FormData = require('form-data');

// 実際に発生した誤変換の修正辞書
const speechCorrectionDict = {
  // ホザナ幼稚園の実際の誤変換
  "おだな幼稚園": "ホザナ幼稚園",
  "おさない幼稚園": "ホザナ幼稚園",
  "幼い幼稚園": "ホザナ幼稚園",
  "小棚幼稚園": "ホザナ幼稚園",
  "児玉幼稚園": "ホザナ幼稚園",
  
  // 預かり保育の実際の誤変換
  "あつかいほいく": "預かり保育",
  "あつがりほいく": "預かり保育",
  "扱い保育": "預かり保育",
  "暑がり保育": "預かり保育",
  
  // 願書の実際の誤変換
  "がんしょう": "願書",
  "眼症": "願書",
  "顔症": "願書",
  "元祥": "願書",
  
  // その他の実際の誤変換
  "ホザナ保育園": "ホザナ幼稚園",
  "保育員": "保育園"
};

// 幼稚園関連の音声認識向上のための特別プロンプト
const KINDERGARTEN_PROMPT = 
  '===== 音声認識コンテキスト：ようちえん入園あんない =====\n' +
  'ほざなようちえんの入園手続きに関する会話です。\n\n' +
  '===== 重要な音声パターン認識 =====\n' + 
  '・「ほざな」- ようちえん名の固有発音\n' +
  '  誤認識されやすい音声：「おだな」「おさない」\n' +
  '・「あずかりほいく」- 重要サービス名\n' +
  '  誤認識されやすい音声：「あつかいほいく」「あつがりほいく」\n' +
  '・「がんしょ」- 入園関連書類名\n' +
  '  誤認識されやすい音声：「がんしょう」\n\n' +
  '===== 文脈ヒント =====\n' + 
  '・「ほざな」と「ようちえん」は常に一体の固有名詞です\n' +
  '・「あずかり」と「ほいく」は常に一体のサービス名です\n' +
  '・この会話はようちえん関連の用語のみを使用します\n' +
  '・入園手続きに関する会話です';

/**
 * 幼稚園関連の誤変換補正を実行する関数
 * @param {string} text - 音声認識された生テキスト
 * @returns {string} - 補正されたテキスト
 */
function correctKindergartenTerms(text) {
  let corrected = text;
  
  // 実際の誤変換パターンに基づく修正
  Object.entries(speechCorrectionDict).forEach(([key, val]) => {
    corrected = corrected.replace(new RegExp(key, 'g'), val);
  });
  
  // 円→園の特殊変換（前後の文脈を考慮）
  corrected = corrected.replace(/(\d+)([万千百十]?)円/g, '$1$2円'); // 数字+円はそのまま
  corrected = corrected.replace(/([^\d０-９万千百十])円/g, '$1園'); // 数字以外+円は園に変換
  
  // 「〜しますか？」が「〜しますから？」になる誤りを修正
  corrected = corrected.replace(/しますから\?/g, 'しますか?');
  
  // ひらがなだけの「ようちえん」を「幼稚園」に変換
  corrected = corrected.replace(/ようちえん/g, '幼稚園');
  
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