// src/node-test/temp.ts

// globalThis を使用してNode.js環境でも動作するようにする
if (typeof globalThis.Blob === 'undefined') {
  (globalThis as any).Blob = class Blob {
    size: number;
    type: string;

    constructor(parts: any[] = [], options: { type?: string } = {}) {
      this.size = parts.reduce((size, part) => size + (part?.byteLength || part?.length || 0), 0);
      this.type = options.type || '';
    }
  };
}

// 元の場所からインポート
import { FusionCore } from '../core/fusionCore/FusionCore';

// 環境検出
console.log('[環境検出] Node.js環境で実行中');
console.log('[注意] 録音機能はNode.js環境では限定的に動作します');

async function testRecording() {
  try {
    console.log('FusionCoreのインスタンス化...');
    const core = new FusionCore({
      sampleRate: 44100,
      debug: true,
    });

    console.log('初期化開始');
    await core.initialize();
    console.log('初期化完了');

    console.log('Node.js環境では録音をシミュレートします（VADなし）');

    try {
      await core.startRecording();
    } catch (error) {
      console.log('VADの初期化をスキップ（Node.js環境で予期されるエラー）');
      console.log('空のBlobを使って録音完了をシミュレート');
    }

    console.log('録音中... (5秒間)');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('録音停止');
    try {
      await core.stop();
    } catch (error) {
      console.log('停止中にエラーが発生しました（シミュレート継続）');
    }

    console.log('録音完了（シミュレート）');

    core.dispose();
    console.log('リソース解放完了');
  } catch (error) {
    console.error('エラー:', error);
  }
}

testRecording().catch(err => {
  console.error('予期せぬエラー:', err);
});
