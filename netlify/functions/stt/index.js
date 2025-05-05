const axios = require('axios');
const FormData = require('form-data');

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // Base64エンコードされた音声データを取得
    const formData = new FormData();
    
    // マルチパートフォームデータをパース
    const blob = Buffer.from(event.body, 'base64');
    formData.append('file', blob, { filename: 'audio.webm', contentType: 'audio/webm' });
    formData.append('model', 'whisper-1');
    formData.append('language', 'ja');

    // OpenAI APIにリクエスト
    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        }
      }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ text: response.data.text || '' })
    };
  } catch (error) {
    console.error('STT error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '音声認識失敗' })
    };
  }
};