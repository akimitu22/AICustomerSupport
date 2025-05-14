// netlify/functions/ai/index.js
import axios from 'axios';
import fs from 'fs';
import path from 'path';

// JSONファイルから直接QandA情報を読み込み
import qandaData from './QandA.json' assert { type: 'json' };
import { speechCorrectionDict } from '../utils/speechMap.js';   
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
    let originalText = message?.trim() || '';
    
    // STT 誤変換辞書を手入力にも適用
    for (const [k, v] of Object.entries(speechCorrectionDict)) {
      originalText = originalText.replaceAll(k, v);
    }
    
    if (originalText.includes('延長') && personHintRe.test(originalText)) {
      originalText = originalText.replaceAll('延長', '園長');
    }
    
    if (!originalText) {
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

## 📚 幼稚園用語の解釈ルール

### 1. 「えんちょう」と「延長保育」の文脈判断（特に重要）
- 「えんちょう」単体で使われる場合（例：「えんちょうはどんな方ですか？」）→ 「園長先生」のことです
- 「えんちょうほいく」という複合語で使われる場合 → 「延長保育」（預かり保育）のことです
- 「保育時間の延長」「延長は何時まで？」など時間・サービスに関する文脈 → 「延長保育」のことです
- 「延長保育の時間」「延長保育の料金」という表現は正しく、この場合の「延長」は園長ではなく「時間延長」の意味です

### 2. その他の重要な専門用語
| 用語 | 正しい解釈 | 文脈例 |
|-----|-----------|-------|
| 「副園長」（ふくえんちょう） | 副園長先生 | 「副園長先生はどんな方ですか？」 |
| 「願書」（がんしょ） | 入園願書 | 「願書はいつからもらえますか？」 |
| 「園児数」（えんじすう） | 園の子どもの人数 | 「園児数は何人ですか？」（※「えんじかず」とは言いません） |
| 「預かり保育」 | 教育時間外の保育 | 「預かり保育の時間は？」 |
| 「モンテッソーリ教育」 | 本園の教育方針 | 「モンテッソーリ教育とは？」 |

## 🧠 文脈判断の優先順位
1. 質問の目的を考える：人物について聞いているのか、サービスについて聞いているのか
2. 時間・料金・申込に関する質問は「延長保育（サービス）」について聞いている可能性が高い
3. 人柄・経歴・面談に関する質問は「園長（人物）」について聞いている可能性が高い
4. 迷った場合は「園長」として解釈し、必要に応じて「もし延長保育についてのご質問でしたら...」と補足する

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
            { role: 'user', content: originalText }
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