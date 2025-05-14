音声対話システム・録音処理モジュール構成ドキュメント
最終更新日: 2025-05-12

概要
このプロジェクトは、ブラウザ上で音声を録音し、VAD（音声検出）とエンコーダー（WAV 生成）を通じて録音データを処理・保存するカスタムモジュール「FusionCore」を中心に構成されています。TypeScript ベースで開発され、Vite をビルドツールに採用しています。

構成ファイルとディレクトリ
📁 src/core/fusionCore/
FusionCore.ts: 音声録音、VAD 検出、WAV エンコードを統括する中核モジュール

AudioSystemMediaRec.ts: MediaRecorder ベースのシンプルな録音クラス

Logger.ts, storage.ts, types.ts: 各種ユーティリティや型定義

index.ts: 上記の統合エクスポートエントリポイント

📁 src/workers/
vad-worker.js: 音声エネルギーに基づく簡易 VAD（音声活動検出）処理

encoder-worker.js: WAV 形式への音声エンコード処理

🔧 注意: ワーカーファイルは Vite によりバンドルされ、import.meta.url 経由で読み込まれます。public/ディレクトリには配置しないでください。

動作確認用ページ
📄 public/recorder-test.html
録音・停止・音声検出・保存までの処理を確認する UI テストページです。

初期化 → 録音開始 → 発話検出 → 停止 → 再生/保存

エラー発生時は #log に表示されます

読み込み元: /src/core/fusionCore/index.ts

実装特徴
✅ 録音処理
MediaRecorder を用いてブラウザから PCM 音声を取得

VAD ワーカーにて音声の開始/終了を判定

録音データは Float32Array で蓄積

✅ VAD（Voice Activity Detection）
vad-worker.js 内でエネルギー検出による簡易判定

VAD 閾値（感度）と無音時間タイムアウトを指定可能

発話区間の切り出しが可能（自動停止対応）

✅ WAV エンコード
encoder-worker.js にて 16bit WAV 形式に変換

ファイルサイズ例：約 8 秒で 800KB 程度（44.1kHz, mono）

使用手順（開発環境）
bash
コピーする
編集する

# 1. 依存関係インストール

npm install

# 2. Vite サーバー起動

npx vite

# 3. 以下の URL をブラウザで開く

http://localhost:5173/recorder-test.html
開発環境とビルド構成
📦 Vite 設定（vite.config.ts）
ts
コピーする
編集する
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
publicDir: 'public',
resolve: {
alias: {
'fusion-core': '/src/core/fusionCore/index.ts'
}
},
server: {
open: '/recorder-test.html'
}
});
📜 TypeScript 設定（tsconfig.json）
json
コピーする
編集する
{
"compilerOptions": {
"target": "ES2020",
"module": "ESNext",
"moduleResolution": "Bundler",
"strict": true,
"esModuleInterop": true,
"skipLibCheck": true
}
}
エラーハンドリングとトラブル対応
現象 原因 対処
Failed to load resource /workers/vad-worker.js ワーカーファイルのパスミス new URL('../workers/vad-worker.js', import.meta.url)を確認
Operation in progress stop 処理が 2 回呼ばれた ロック制御で Guard されているか確認
Assignment to constant variable const 変数に再代入 encoder-worker.js 内の let offset = 44 に修正

日本語応答サポートポリシー
本システムは、カスタマーサポート用途で使用されるため、以下の方針を内部的に保持・制御しています：

否定語・非礼表現を回避（例：「できません」→「現在は対応していません」）

二人称「君」等の使用禁止

生成 AI 側プロンプトおよびフィルター層により制御

今後の改善計画
AudioWorklet ベースへの切り替え

VAD の精度向上（RMS ではなく FFT 利用）

自動テスト（Playwright/WebKit）導入

CI/CD 対応（Netlify Rollbacks 含む）

著作権とライセンス
本システムは 学校法人ホザナ学園 にて運用されており、関係者以外の二次使用を禁じます。
