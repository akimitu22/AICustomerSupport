// netlify/functions/stt/index.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');

exports.handler = async function(event, context) {
  console.log("STT関数が呼び出されました");
  
  // CORS対応
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }
  
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // APIキー確認
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API Key is not set');
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ 
          error: "API設定エラー", 
          details: "OpenAI APIキーが設定されていません"
        })
      };
    }

    // Base64データを取得
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (parseError) {
      // マルチパートフォームデータの可能性を確認
      if (event.isBase64Encoded) {
        // Base64エンコードされたマルチパートデータを処理
        const buffer = Buffer.from(event.body, 'base64');
        
        // 一時ファイルに保存
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `audio_${Date.now()}.webm`);
        fs.writeFileSync(tempFilePath, buffer);
        
        // Whisper APIに送信
        const formData = new FormData();
        formData.append('file', fs.createReadStream(tempFilePath));
        formData.append('model', 'whisper-1');
        formData.append('language', 'ja');
        
        const whisperResponse = await axios.post(
          'https://api.openai.com/v1/audio/transcriptions',
          formData,
          {
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              ...formData.getHeaders()
            }
          }
        );
        
        // 一時ファイル削除
        try {
          fs.unlinkSync(tempFilePath);
        } catch (unlinkError) {
          console.error('Failed to delete temp file:', unlinkError);
        }
        
        const recognizedText = whisperResponse.data.text;
        
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          },
          body: JSON.stringify({
            text: recognizedText,
            success: true
          })
        };
      } else {
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          },
          body: JSON.stringify({
            error: "無効なリクエスト形式です",
            details: "JSONの解析に失敗しました"
          })
        };
      }
    }
    
    // JSONデータからオーディオを取得
    const { audio } = requestBody;
    if (!audio) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
          error: "音声データがありません",
          details: "リクエストに'audio'フィールドが必要です"
        })
      };
    }
    
    // Base64データをバイナリに変換
    const audioBuffer = Buffer.from(audio, 'base64');
    
    // 一時ファイルに保存
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `audio_${Date.now()}.webm`);
    fs.writeFileSync(tempFilePath, audioBuffer);
    
    // Whisper APIに送信
    const formData = new FormData();
    formData.append('file', fs.createReadStream(tempFilePath));
    formData.append('model', 'whisper-1');
    formData.append('language', 'ja');
    
    const whisperResponse = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          ...formData.getHeaders()
        }
      }
    );
    
    // 一時ファイル削除
    try {
      fs.unlinkSync(tempFilePath);
    } catch (unlinkError) {
      console.error('Failed to delete temp file:', unlinkError);
    }
    
    const recognizedText = whisperResponse.data.text;
    
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        text: recognizedText,
        success: true
      })
    };
  } catch (error) {
    console.error('STT error:', error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ 
        error: "音声認識処理中にエラーが発生しました", 
        details: String(error) 
      })
    };
  }
};