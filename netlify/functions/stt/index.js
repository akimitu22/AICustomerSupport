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
  
  console.log("STT関数が呼び出されました - 基本テスト");
  
  // 単純な成功レスポンスを返す
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      text: "音声認識テスト成功 - このメッセージが表示されれば接続は正常です",
      success: true
    })
  };
};