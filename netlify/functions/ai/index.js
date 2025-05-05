const axios = require('axios');

exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { message, sessionId } = JSON.parse(event.body);
    if (!message?.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'empty' })
      };
    }

    const sid = sessionId || `s_${Date.now()}`;

    // OpenAI APIにリクエスト
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `ホザナ幼稚園の入園コンシェルジュです。園に関する質問に250文字程度で親切・丁寧に回答してください。
            ※見学を希望される方には「このページ上部の見学予約ボタンからお申し込みください」と案内してください。
            ※電話番号は絶対に読み上げないでください。
            ※お問い合わせには「ホームページのお問い合わせフォームからどうぞ」と案内してください。
            ※「電話でのお問い合わせ」という言葉や電話番号は絶対に使わないでください。
            不明点は「園へお問い合わせください」と案内してください。`
          },
          { role: 'user', content: message }
        ],
        max_tokens: 400,
        temperature: 0.5
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    const reply = data.choices?.[0]?.message?.content || '申し訳ありません、回答を生成できませんでした。';

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        reply, 
        sessionId: sid, 
        stage: 'initial' // ステージ管理はシンプル化
      })
    };
  } catch (e) {
    console.error('AI error:', e);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: '回答生成失敗' })
    };
  }
};