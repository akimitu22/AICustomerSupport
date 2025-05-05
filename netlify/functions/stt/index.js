// netlify/functions/stt/index.js
exports.handler = async function(event, context) {
  // CORSヘッダー
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
  
  // OPTIONSリクエスト
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: "" };
  }
  
  console.log("STT関数開始 - デバッグ情報");
  console.log("Content-Type:", event.headers['content-type'] || event.headers['Content-Type']);
  console.log("isBase64Encoded:", event.isBase64Encoded);
  
  try {
    // マルチパートデータまたはJSON、どちらの形式でも対応できるようにする
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        text: "テスト応答です。音声認識は実装していません。",
        success: true
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