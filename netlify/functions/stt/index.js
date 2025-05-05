// netlify/functions/stt/index.js
const axios = require('axios');
const FormData = require('form-data');

exports.handler = async function(event, context) {
  // 改善されたCORSヘッダー
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  
  // OPTIONSリクエスト処理
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: "" };
  }
  
  // POSTメソッド以外は拒否
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method Not Allowed' }) 
    };
  }
  
  // デバッグログ
  console.log("STT関数開始 - Whisper API実装");
  console.log("isBase64Encoded:", event.isBase64Encoded);
  
  try {
    // Content-Type判定を改善
    const contentType = event.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      console.log("非JSONリクエストを検出:", contentType);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "JSONリクエストが必要です",
          success: false
        })
      };
    }
    
    // JSONパース
    let requestBody;
    try {
      requestBody = JSON.parse(event.body || '{}');
    } catch (parseError) {
      console.error("JSONパースエラー:", parseError);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "JSONパースエラー",
          details: parseError.message,
          success: false
        })
      };
    }
    
    // 音声データチェック
    if (!requestBody.audio) {
      console.error("音声データなし");
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "音声データがありません",
          success: false
        })
      };
    }
    
    // サイズログ（音声データ自体は出力しない）
    console.log("音声データ長:", requestBody.audio.length);
    console.log("フォーマット:", requestBody.format);
    
    // APIキーチェック
    if (!process.env.OPENAI_API_KEY) {
      console.error("OpenAI APIキーが設定されていません");
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "APIキーが設定されていません",
          success: false
        })
      };
    }
    
    // Base64データをバイナリに変換
    const audioBuffer = Buffer.from(requestBody.audio, 'base64');
    
    // サイズチェック（Netlify Functionsは~10MB制限）
    const sizeInMB = audioBuffer.length / (1024 * 1024);
    if (sizeInMB > 9.5) {
      console.error(`音声データが大きすぎます: ${sizeInMB.toFixed(2)}MB`);
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({
          error: "音声データが大きすぎます (10MB制限)",
          success: false
        })
      };
    }
    
    // FormDataの作成
    const formData = new FormData();
    formData.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: requestBody.format || 'audio/webm'
    });
    formData.append('model', 'whisper-1');
    formData.append('language', 'ja');
    
    // FormDataヘッダーの準備
    const fdHeaders = formData.getHeaders();
    // Content-Lengthを正確に設定（Node 18環境での安定性向上）
    fdHeaders['Content-Length'] = await new Promise(resolve => 
      formData.getLength((err, length) => resolve(length))
    );
    
    // Whisper APIへリクエスト（タイムアウト設定とサイズ制限を追加）
    console.log("Whisper APIにリクエスト送信");
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...fdHeaders
        },
        maxBodyLength: 25 * 1024 * 1024, // 送信サイズ制限
        maxContentLength: 25 * 1024 * 1024, // 受信サイズ制限
        timeout: 25000 // 25秒タイムアウト
      }
    );
    
    console.log("Whisper API応答ステータス:", response.status);
    console.log("応答データタイプ:", typeof response.data);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text: response.data.text,
        success: true
      })
    };
  } catch (error) {
    console.error("STTエラー:", error);
    
    // エラーの完全なスタックトレースをログ出力
    if (error.stack) {
      console.error(error.stack);
    }
    
    // APIからのエラーレスポンスがあれば詳細を出力
    if (error.response?.data) {
      console.error("API詳細エラー:", JSON.stringify(error.response.data));
    }
    
    // Axiosタイムアウトの特別処理
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      return {
        statusCode: 504,
        headers,
        body: JSON.stringify({ 
          error: "音声認識処理がタイムアウトしました",
          details: error.message,
          success: false
        })
      };
    }
    
    // OpenAI APIからのエラーステータスをそのまま返す
    if (error.response?.status) {
      return {
        statusCode: error.response.status,
        headers,
        body: JSON.stringify({ 
          error: "Whisper APIエラー",
          details: error.response.data?.error?.message || error.message,
          success: false
        })
      };
    }
    
    // その他の一般エラー
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "音声認識処理エラー",
        details: error.message,
        success: false
      })
    };
  }
};