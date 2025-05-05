// netlify/functions/stt/index.js
exports.handler = async function(event, context) {
  // CORS対応用ヘッダー
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  
  // OPTIONSリクエスト（プリフライト）の処理
  if (event.httpMethod === 'OPTIONS') {
    return { 
      statusCode: 200, 
      headers, 
      body: "" 
    };
  }
  
  console.log("STT関数が呼び出されました - Base64テスト");
  
  try {
    // リクエストのパース
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
    
    // 音声データのチェック
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
    
    // データのログ出力（デバッグ用）
    console.log("音声データ長:", requestBody.audio.length);
    console.log("フォーマット:", requestBody.format);
    console.log("録音時間:", requestBody.duration, "秒");
    
    // この段階ではまだWhisper APIは使わず、テスト応答を返す
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text: `音声データを受信しました（${Math.round(requestBody.audio.length / 1024)}KB、${requestBody.duration.toFixed(1)}秒）。実際の音声認識はまだ実装していません。`,
        success: true
      })
    };
  } catch (error) {
    console.error("STTエラー:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "処理エラー", 
        details: error.message,
        success: false
      })
    };
  }
};