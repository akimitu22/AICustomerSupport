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
  "かんしょう": "願書",
  "干渉": "願書",
  "眼症": "願書",
  "顔症": "願書",
  "元祥": "願書",
  "がんしょ": "願書",
  "かんしょ": "願書",
  "幹書": "願書",
  "みきしょ": "願書",
  
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
  '  誤認識されやすい音声：「がんしょう」「かんしょ」「みきしょ」\n\n' +
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

/**
 * 一貫したレスポンス形式を生成するヘルパー関数
 * @param {number} statusCode - HTTPステータスコード 
 * @param {Object} headers - HTTPヘッダー
 * @param {Object} data - レスポンスデータ 
 * @param {string} [errorMessage] - エラーメッセージ（エラー時のみ）
 * @returns {Object} - 形式化されたレスポンス
 */
function formatResponse(statusCode, headers, data = {}, errorMessage = null) {
  // 一貫した形式のボディを作成
  const responseBody = {
    success: statusCode >= 200 && statusCode < 300
  };
  
  // エラーの場合はエラー情報を追加
  if (errorMessage) {
    responseBody.error = errorMessage;
    if (data.details) {
      responseBody.details = data.details;
    }
  } 
  // 成功の場合はデータをマージ
  else {
    Object.assign(responseBody, data);
    
    // text プロパティが必ず存在することを保証
    if (!responseBody.text && responseBody.stt && responseBody.stt.text) {
      responseBody.text = responseBody.stt.text;
    } 
    
    // text が空文字列または未定義の場合の対応
    if (!responseBody.text || responseBody.text.trim() === '') {
      // 音声認識が空の場合はエラーとして処理
      responseBody.success = false;
      responseBody.error = "認識されたテキストが空です";
      responseBody.text = "認識エラー"; // エラーメッセージをテキストにセット
      // ステータスコードを変更
      statusCode = 422; // Unprocessable Entity
    }
  }
  
  return {
    statusCode,
    headers,
    body: JSON.stringify(responseBody)
  };
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
    return formatResponse(405, headers, {}, 'Method Not Allowed');
  }

  console.log("STT start");
  console.log("isBase64Encoded:", event.isBase64Encoded);

  try {
    // リクエストの検証
    const contentType = event.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return formatResponse(400, headers, {}, "JSON required");
    }

    let req;
    try {
      req = JSON.parse(event.body || '{}');
    } catch (e) {
      return formatResponse(400, headers, { details: e.message }, "JSON parse error");
    }

    if (!req.audio) {
      return formatResponse(400, headers, {}, "No audio data");
    }

    if (!process.env.OPENAI_API_KEY) {
      return formatResponse(500, headers, {}, "API key missing");
    }

    // 音声データの準備と検証
    console.log("Audio length:", req.audio.length);
    console.log("Format:", req.format);
    
    const audioBuffer = Buffer.from(req.audio, 'base64');
    const sizeMB = audioBuffer.length / (1024 * 1024);
    if (sizeMB > 9.5) {
      return formatResponse(413, headers, {}, "Audio too large (>10MB)");
    }

    // Whisper APIを呼び出し
    console.log("Calling Whisper API");
    const resp = await callWhisperAPI(audioBuffer, req.format);
    console.log("Whisper status:", resp.status);

    // 音声認識結果の補正処理
    let recognizedText = resp.data.text || '';
    
    // 認識テキストが空かチェック
    if (!recognizedText.trim()) {
      return formatResponse(422, headers, {}, "音声認識テキストが空です");
    }
    
    let correctedText = correctKindergartenTerms(recognizedText);
    
    // 入力と修正結果が異なる場合はログ出力
    if (recognizedText !== correctedText) {
      console.log("Text correction applied:");
      console.log("Before:", recognizedText);
      console.log("After:", correctedText);
    }

    // 一貫したレスポンス形式で返す
    return formatResponse(200, headers, { 
      text: correctedText, 
      originalText: recognizedText,
      timestamp: Date.now()
    });

  } catch (error) {
    console.error("STT error:", error);
    if (error.stack) console.error(error.stack);
    
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      return formatResponse(504, headers, { details: error.message }, "Timeout");
    }
    
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    return formatResponse(status, headers, { details: detail }, "Whisper API error");
  }
};