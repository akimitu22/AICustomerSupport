// vite.config.ts
import { defineConfig } from 'vite';
import { resolve } from 'path';
import * as fs from 'fs';
import * as path from 'path';

export default defineConfig({
  // 既存の設定を保持
  resolve: {
    alias: {
      'fusion-core': resolve(__dirname, 'src/core/fusionCore/index.ts'),
    },
  },
  server: {
    open: false
  },
  publicDir: 'public',

  // ビルド時にワーカーファイルを自動コピーするプラグインを追加
  plugins: [
    {
      name: 'copy-worklets-on-build',
      buildStart() {
        console.log('Preparing worklet files for build...');
      },
      writeBundle() {
        // ビルド出力にワーカーファイルをコピー
        const workletsSrcDir = path.resolve(__dirname, 'public/fusionCore/worklets');
        const workletsDestDir = path.resolve(__dirname, 'dist/fusionCore/worklets');

        if (!fs.existsSync(workletsDestDir)) {
          fs.mkdirSync(workletsDestDir, { recursive: true });
        }

        if (fs.existsSync(workletsSrcDir)) {
          const files = fs.readdirSync(workletsSrcDir);
          for (const file of files) {
            if (file.endsWith('.js')) {
              fs.copyFileSync(path.join(workletsSrcDir, file), path.join(workletsDestDir, file));
              console.log(`Copied ${file} to dist/fusionCore/worklets/`);
            }
          }
        }
      },
    },
  ],
});
