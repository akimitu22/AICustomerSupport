// netlify/functions/stt/index.js
const axios = require('axios');

exports.handler = async function(event, context) {
  // CORSヘッダー
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  
  // OPTIONSリクエスト処理
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: "" };
  }
  
  // デバッグログ
  console.log("STT関数開始 - Whisper API実装");
  console.log("Content-Type:", event.headers['content-type'] || event.headers['Content-Type']);
  console.log("isBase64Encoded:", event.isBase64Encoded);
  
  try {
    // マルチパートフォームデータの処理
    if (event.headers['content-type']?.includes('multipart/form-data')) {
      console.log("マルチパートフォームデータを検出しました");
      
      // FormDataはサーバーレス環境では処理が複雑なため、テスト応答を返す
      console.log("現在の実装では音声データを処理できません。クライアント側をBase64+JSON方式に変更してください");
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          text: "音声認識テスト中です（マルチパート形式検出）。クライアント側をBase64+JSON方式に変更してください。",
          success: true
        })
      };
    }
    
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
    
    // JSONリクエストの処理（将来的なBase64+JSON方式用）
    if (event.headers['content-type']?.includes('application/json')) {
      console.log("JSONデータを検出しました");
      
      // JSON解析テスト
      try {
        const requestBody = JSON.parse(event.body || '{}');
        console.log("JSONパース成功。audioフィールド:", requestBody.audio ? "あり" : "なし");
        
        // 現段階ではテスト応答を返す
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            text: "JSON形式を正常に受信しました。この段階ではまだWhisper APIを呼び出していません。",
            success: true
          })
        };
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
    }
    
    // 不明なContent-Type
    console.log("不明なContent-Type:", event.headers['content-type']);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "不明なリクエスト形式",
        details: "Content-Type: " + (event.headers['content-type'] || "不明"),
        success: false
      })
    };
  } catch (error) {
    console.error("STTエラー:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "サーバー内部エラー",
        details: error.message,
        success: false
      })
    };
  }
};