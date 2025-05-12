// netlify/functions/ai/index.js
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// JSONファイルから直接QandA情報を読み込み
import qandaData from './QandA.json' assert { type: 'json' };
const kindergartenQA = qandaData.kindergartenQA;

export const handler = async function(event, context) {
  // Preflight requestへの対応
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
    // リクエストのJSONパース
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (parseError) {
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
    
    const { message, sessionId } = requestBody;
    if (!message?.trim()) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ 
          error: "メッセージが空です",
          details: "有効なメッセージを入力してください"
        })
      };
    }

    // APIキーが設定されているか確認
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

    const sid = sessionId || `s_${Date.now()}`;
    
    // QandA情報をコンテキストに変換
    const qaContext = kindergartenQA
      .map(q => `Q: ${q.question}\nA: ${q.answer}`)
      .join('\n');

    // OpenAI APIにリクエスト
    try {
      const { data } = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `ホザナ幼稚園の入園コンシェルジュです。園に関する質問に200文字前後で親切・丁寧に回答してください。
              
以下のQandA情報を必ず参考にして、正確な回答を提供してください。特に入園料、給食費、保育内容などの具体的な質問には、必ずこの情報から回答してください：

----- QandA 情報 -----
${qaContext}
---------------------

※見学を希望される方には「このページ上部の見学予約ボタンからお申し込みください」と案内してください。
※電話番号は絶対に読み上げないでください。
※お問い合わせには「ホームページのお問い合わせフォームからどうぞ」と案内してください。
※「電話でのお問い合わせ」という言葉や電話番号は絶対に使わないでください。
不明点は「園へお問い合わせください」と案内してください。
※お問合せ内容は幼稚園に関することですので。「えんちょう」は「延長保育」か「園長先生」のことと解釈し、「がんしょ(う)」は「顔症」や「眼症」ではなく、「(入園)願書」のことと理解し、幼稚園用語以外に受け取って誤った解釈は絶対しないでください。`
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
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ 
          reply, 
          sessionId: sid, 
          stage: 'initial' // ステージ管理はシンプル化
        })
      };
    } catch (apiError) {
      console.error('OpenAI API error:', apiError.response?.data || apiError.message);
      return {
        statusCode: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ 
          error: 'OpenAI API エラー', 
          details: apiError.response?.data?.error?.message || apiError.message 
        })
      };
    }
  } catch (e) {
    console.error('AI処理エラー:', e);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ 
        error: 'AI応答生成失敗', 
        details: e.message 
      })
    };
  }
};