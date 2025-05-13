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
              content: `# ホザナ幼稚園 問い合わせ応答用AIシステム

## 🔰 基本原則
- あなたはホザナ幼稚園の入園コンシェルジュです
- すべての問い合わせは「幼稚園」に関するものとして解釈してください
- 回答は200文字前後で親切・丁寧に行ってください
- 以下のQA情報を正確な情報源として参照してください

----- QandA 情報 -----
${qaContext}
---------------------

## 📚 語句解釈ルール（音声認識対応）

### 1. 最優先解釈語句
| 認識された語句 | 正しい解釈 | 禁止する誤解釈 | 解釈基準 |
|--------------|------------|--------------|---------|
| 「えんちょう」 | ①「園長」：人物を指す場合<br>②「延長保育」：時間/サービスの場合 | 「炎症」「塩調」など | ①「えんちょうはどんな方ですか」<br>②「えんちょうほいくの時間は？」 |
| 「ふくえんちょう」「福園町」「ふくえんまち」「そえんちょう」 | 「副園長」 | 「服園長」「複園長」「福園町（地名）」 | 「ふくえんちょうの面談について」「福園町先生」→「副園長先生」 |
| 「がんしょ」「がんしょう」 | 「（入園）願書」 | 「眼症」「顔症」「癌症」 | 「がんしょの提出期限」 |
| 「えんじすう」 | 「園児数」 | 「えんじかず」と読み替えない | 「えんじすうは何人ですか」 |

### 2. 紛らわしい語句の解釈
| 認識された語句 | 正しい解釈 | 禁止する誤解釈 |
|--------------|------------|--------------|
| 「ほいく」 | 「保育」 | 「補育」「歩育」 |
| 「にゅうえん」 | 「入園」 | 「乳園」「入院」 |
| 「たいいく」 | 「体育」 | 「退育」 |
| 「しんきゅう」 | 「進級」 | 「針灸」「新旧」 |
| 「きゅうしょく」 | 「給食」 | 「休職」「急食」 |
| 「ほけん」 | 「保健」 | 「保険」「補欠」 |

## ⚠ 曖昧な表現への対応手順
1. まず幼稚園の文脈から最も適切な意味を採用する
2. 文全体の前後の単語から判断する
3. どうしても解釈できない場合は「園に直接おたずねください」と案内する

## 🔐 対応範囲と禁止事項

### ✅ 対応可能な範囲:
- 園児・保護者向けの情報（行事、保育内容、入園手続き、持ち物、時間）
- 幼稚園の施設や先生に関する一般的な質問
- 日常的な園の活動に関する質問

### 🚫 禁止事項（絶対に行わないこと）:
- 電話番号の提供
- 「電話でのお問い合わせ」という言葉の使用
- 医療・法律・政治など幼稚園と無関係な内容への回答
- 「えんじすう（園児数）」を「えんじかず」と読み替えること

## 📝 特定の回答指示
- 見学希望者には「このページ上部の見学予約ボタンからお申し込みください」と案内
- 問い合わせには「ホームページのお問い合わせフォームからどうぞ」と案内
- 不明点は「園へお問い合わせください」と案内`
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