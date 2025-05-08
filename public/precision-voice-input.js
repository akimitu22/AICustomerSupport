/**
 * PrecisionVoiceInput - ホザナ幼稚園音声サポート用カスタム実装
 * v1.1.2
 * 
 * - すべての主要ブラウザとiOS Safariで安定動作
 * - シンプルなコードベースで保守容易性を確保
 * - サーバーサイド連携またはスタンドアロンモードを選択可能
 * 
 * 注: 動的インポートを使用する場合、グローバル設定のために以下のようにしてください:
 * ```javascript
 * const m = await import('./precision-voice-input.js');
 * window.PrecisionVoiceInput = m.default;
 * ```
 * これにより、`new PrecisionVoiceInput(...)`がグローバルに可能になります。
 * 将来的な改善: `ScriptProcessorNode`は非推奨のため、`AudioWorklet`への移行を検討してください。
 */

// ESモジュールとして実装
class PrecisionVoiceInput {
  constructor({ containerId, apiEndpoint, language = 'ja-JP', onResult }) {
    // 必須パラメータ検証
    if (!containerId) {
      throw new Error('containerId は必須です');
    }
    
    // 基本設定
    this.container = document.getElementById(containerId);
    if (!this.container) throw new Error(`コンテナ要素が見つかりません: ${containerId}`);
    this.apiEndpoint = apiEndpoint || '/.netlify/functions/stt'; // デフォルトエンドポイント
    this.language = language;
    this.onResult = onResult || function() {};
    
    // 状態変数
    this.isRecording = false;
    this.isProcessing = false;
    this.isInitialized = false;
    this.hasStartedRecording = false; // 実際の録音開始フラグ
    this.recordingStartTime = 0;     // 実際の録音開始時刻
    
    // リソース参照
    this.audioContext = null;
    this.stream = null;
    this.recorder = null;
    this.processor = null;
    this.analyser = null;
    this.gainNode = null; // ゲインノードを保持
    this.chunks = [];
    
    // 音声検出設定
    this.vadThreshold = 0.015;  // 基本閾値（環境に応じて調整される）
    this.silenceCounter = 0;    // 小文字で統一
    this.maxSilenceFrames = 15; // 約1.5秒の無音で停止（client.jsに合わせる）
    this.isSpeaking = false;
    
    // ブラウザ検出
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    this.isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    
    // タイマー参照（未使用のuiUpdateとactivityを削除）
    this.timers = {
      maxDuration: null,     // 最大録音時間
      noSpeechTimeout: null  // 無音タイムアウト
    };
    
    // イベントリスナー参照
    this._boundClick = null;
    this._boundVisibilityChange = null;
    
    // UI初期化
    this._initUI();
    this.isInitialized = true;
  }
  
  /**
   * UI初期化
   * @private
   */
  _initUI() {
    // UIをクリア
    this.container.innerHTML = '';
    
    // ボタン作成
    this.button = document.createElement('button');
    this.button.className = 'voice-button';
    this.button.setAttribute('aria-label', '音声入力を開始');
    this.button.textContent = '🎤';
    
    // ステータス表示
    this.status = document.createElement('div');
    this.status.className = 'voice-status';
    this.status.setAttribute('aria-live', 'polite');
    this.status.textContent = 'ボタンをタップして話しかけてください';
    
    // コンテナに追加
    this.container.appendChild(this.button);
    this.container.appendChild(this.status);
    
    // イベントリスナー（bindを一度だけ行い、参照を保持）
    this._boundClick = this._handleButtonClick.bind(this);
    this.button.addEventListener('click', this._boundClick);
  }
  
  /**
   * ボタンクリックハンドラ
   * @private
   */
  _handleButtonClick() {
    if (this.isRecording) {
      this.stop();
    } else {
      this.start();
    }
  }
  
  /**
   * AudioContextを再開する（再試行ロジック付き）
   * @private
   */
  async _resumeAudioContext() {
    const maxRetries = 3;
    let retries = 0;
    while (retries < maxRetries && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        return true;
      } catch (e) {
        console.warn(`AudioContext resume attempt ${retries + 1} failed:`, e);
        retries++;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    return this.audioContext.state !== 'suspended';
  }
  
  /**
   * 録音開始
   * @public
   */
  async start() {
    if (this.isRecording || this.isProcessing) return;
    
    this.isProcessing = true;
    this._updateUI('マイクを準備中...', false);
    
    try {
      // マイクアクセス
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      
      // AudioContext初期化
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      // AudioContextを再開（iOS Safari対応）
      const resumed = await this._resumeAudioContext();
      if (!resumed) {
        throw new Error('AudioContextを再開できませんでした。ページをリロードしてください。');
      }
      
      // visibilitychangeイベントで再試行（iOS 15以下のタイミング依存エラー対応）
      this._boundVisibilityChange = async () => {
        if (document.visibilityState === 'visible' && this.audioContext?.state === 'suspended') {
          const resumed = await this._resumeAudioContext();
          if (!resumed) {
            this._handleError(new Error('AudioContextを再開できませんでした。ページをリロードしてください。'));
          }
        }
      };
      document.addEventListener('visibilitychange', this._boundVisibilityChange);
      
      // 音声分析のセットアップ
      await this._setupAudioAnalysis();
      
      // MediaRecorder セットアップ - 実際の録音は発話検出後に開始
      const types = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/ogg;codecs=opus',
        'audio/mpeg'
      ];
      const mimeType = types.find(t => MediaRecorder.isTypeSupported(t));
      this.mimeTypeFallback = mimeType || 'audio/webm'; // フォールバックを保持
      this.recorder = new MediaRecorder(
        this.stream, 
        mimeType ? { mimeType } : undefined
      );
      
      this.chunks = [];
      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };
      
      this.recorder.onstop = () => {
        this._processRecording();
      };
      
      // タイマーの重複を防ぐ
      if (this.timers.maxDuration) {
        clearTimeout(this.timers.maxDuration);
        this.timers.maxDuration = null;
      }
      if (this.timers.noSpeechTimeout) {
        clearTimeout(this.timers.noSpeechTimeout);
        this.timers.noSpeechTimeout = null;
      }
      
      // 最大録音時間（30秒）の設定
      this.timers.maxDuration = setTimeout(() => {
        if (this.isRecording) {
          console.info('最大録音時間に到達しました');
          this.stop();
        }
      }, 30000);
      
      // 無音タイムアウト - 15秒間発話がなければ停止
      this.timers.noSpeechTimeout = setTimeout(() => {
        if (this.isRecording && !this.hasStartedRecording) {
          console.info('発話が検出されませんでした');
          this._updateUI('発話が検出されませんでした。もう一度お試しください', true);
          this.stop();
        }
      }, 15000);
      
      // 録音開始時刻（準備開始時刻）
      this.startTime = Date.now();
      this.isRecording = true;
      this.isProcessing = false;
      this.hasStartedRecording = false; // 実際の録音はまだ開始していない
      this._updateUI('話しかけてください...', false);
      
      // 親ページのステータス表示を更新
      this._updateExternalStatus('🎧 どうぞお話しください…', false);
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * 外部ステータス更新（#status用）
   * @private
   */
  _updateExternalStatus(message, isError) {
    const statusElement = document.getElementById('status');
    if (statusElement) {
      statusElement.textContent = message;
      statusElement.classList.toggle('error', isError);
    }
  }
  
  /**
   * 音声分析のセットアップ
   * @private
   */
  async _setupAudioAnalysis() {
    // ソース作成
    const source = this.audioContext.createMediaStreamSource(this.stream);
    
    // アナライザーノード
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    
    // 環境ノイズのキャリブレーション
    await this._calibrateNoise();
    
    // ゲインノード (client.js と同様)
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1.5;
    
    // プロセッサーノード
    this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);
    source.connect(this.gainNode);
    this.gainNode.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    
    // オーディオ処理
    this.processor.onaudioprocess = (e) => {
      if (!this.isRecording) return;
      
      // 音量計算
      const buffer = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) {
        sum += buffer[i] * buffer[i];
      }
      const volume = Math.sqrt(sum / buffer.length);
      
      // 発話検出
      if (volume > this.vadThreshold) {
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          this._updateUI('音声を検出しました...録音中', false);
          
          // 録音がまだ始まっていなければ開始
          if (this.recorder && this.recorder.state === 'inactive') {
            try {
              // 実際の録音開始時刻を記録
              this.recordingStartTime = Date.now();
              this.hasStartedRecording = true;
              
              // no-speech タイムアウトをクリア
              if (this.timers.noSpeechTimeout) {
                clearTimeout(this.timers.noSpeechTimeout);
                this.timers.noSpeechTimeout = null;
              }
              
              this.recorder.start();
              
              // 親ページのステータス表示を更新
              this._updateExternalStatus('📢 発話中…', false);
            } catch (err) {
              console.warn('録音開始エラー:', err);
              this.hasStartedRecording = false; // 録音失敗時にフラグをリセット
              this.recorder = null; // ハンドラが残らないようクリア
            }
          }
        }
        
        // 無音カウンタリセット
        this.silenceCounter = 0;
      } 
      else if (this.isSpeaking) {
        // 無音カウント
        this.silenceCounter++;
        
        // 一定フレーム数以上の無音で録音停止
        if (this.silenceCounter > this.maxSilenceFrames) {
          this.isSpeaking = false;
          if (this.recorder && this.recorder.state === 'recording') {
            this.stop();
            
            // 親ページのステータス表示を更新
            this._updateExternalStatus('🧠 認識中…', false);
          }
        }
      }
    };
  }
  
  /**
   * 環境ノイズのキャリブレーション
   * @private
   */
  async _calibrateNoise() {
    return new Promise(resolve => {
      const dataArray = new Float32Array(this.analyser.frequencyBinCount);
      
      // サンプリング設定
      const samples = [];
      const sampleCount = 10;
      let currentSample = 0;
      
      // サンプリング関数
      const sampleNoise = () => {
        if (currentSample >= sampleCount) {
          // サンプリング完了、閾値計算
          samples.sort((a, b) => a - b);
          const medianIndex = Math.floor(samples.length / 2);
          const medianNoise = samples[medianIndex];
          
          // 背景ノイズの3倍を閾値に設定（最小値保証）
          this.vadThreshold = Math.max(0.015, medianNoise * 3);
          
          // iOS Safariは閾値を調整（マイク感度が低いため）
          if (this.isIOS && this.isSafari) {
            this.vadThreshold *= 0.8;
          }
          
          console.info(`ノイズキャリブレーション完了: ${this.vadThreshold.toFixed(6)}`);
          resolve();
          return;
        }
        
        // RMS音量測定
        this.analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);
        samples.push(rms);
        
        // 次のサンプル
        currentSample++;
        setTimeout(sampleNoise, 50);
      };
      
      // サンプリング開始
      sampleNoise();
    });
  }
  
  /**
   * 録音停止
   * @public
   */
  stop() {
    if (!this.isRecording) return;
    
    this.isRecording = false;
    this._updateUI('処理中...', false);
    
    // タイマークリア
    Object.keys(this.timers).forEach(key => {
      if (this.timers[key]) {
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    });
    
    // プロセッサ停止
    if (this.processor) {
      try {
        this.processor.disconnect();
        this.processor.onaudioprocess = null; // イベントハンドラをクリア
      } catch (e) {
        console.warn('プロセッサ切断エラー:', e);
      }
      this.processor = null;
    }
    
    // 録音中であれば停止
    if (this.recorder && this.recorder.state === 'recording') {
      try {
        this.recorder.stop();
      } catch (e) {
        console.warn('録音停止エラー:', e);
        this._cleanupResources();
        this._updateUI('エラーが発生しました。もう一度お試しください。', true);
      }
    } else {
      // 録音が開始されていない場合は即座にクリーンアップ
      this._cleanupResources();
      this._updateUI('音声が検出されませんでした。もう一度お試しください。', false);
    }
  }
  
  /**
   * 録音データの処理
   * @private
   */
  async _processRecording() {
    // 録音が実際に開始されていなかった場合はスキップ
    if (!this.hasStartedRecording || this.chunks.length === 0) {
      console.info('有効な録音データがありません');
      this._cleanupResources();
      
      // UIを更新
      this._updateUI('音声が検出されませんでした。もう一度お試しください。', false);
      
      // 親ページのステータス表示を更新
      this._updateExternalStatus('🎧 どうぞお話しください…', false);
      
      return;
    }
    
    try {
      // Blob作成（mimeTypeのフォールバックを明示）
      const format = this.recorder && this.recorder.mimeType
        ? this.recorder.mimeType
        : this.mimeTypeFallback;
      const blob = new Blob(this.chunks, { type: format });
      
      // 録音時間をチェック - 短すぎる場合は処理しない
      const duration = (Date.now() - this.recordingStartTime) / 1000;  // 実際の録音開始時刻から計算
      if (duration < 1.5) {
        this._updateUI('❌ 発話が短すぎます。もう少し長く話してください。', true);
        
        // ステータス表示を更新
        this._updateExternalStatus('❌ 発話が短すぎます。もう少し長く話してください。', true);
        
        this._cleanupResources();
        return;
      }
      
      // リソースクリーンアップ（早めに解放）
      this._cleanupResources();
      
      this._updateUI('発話認識中...', false);
      
      // 親ページのステータス表示を更新
      this._updateExternalStatus('🧠 発話認識中…', false);
      
      // ArrayBufferに変換
      const arrayBuffer = await blob.arrayBuffer();
      const base64Data = btoa(
        new Uint8Array(arrayBuffer).reduce(
          (data, byte) => data + String.fromCharCode(byte), ''
        )
      );
      
      console.info(`音声データサイズ: ${Math.round(base64Data.length / 1024)}KB, 録音時間: ${duration}秒`);
      
      // STTリクエスト送信
      try {
        const response = await fetch(this.apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            audio: base64Data,
            format: format,
            duration: duration
          })
        });
        
        if (!response.ok) {
          if (response.status === 422) {
            throw new Error("音声を認識できませんでした。もう少しはっきり話してください。");
          } else {
            throw new Error(`STTサーバーエラー: ${response.status} ${response.statusText}`);
          }
        }
        
        // レスポンスのJSONパース
        let sttResult;
        try {
          sttResult = await response.json();
          console.info("STT結果(生データ):", sttResult);
        } catch (jsonError) {
          console.warn("JSONパースエラー:", jsonError);
          throw new Error(`STTレスポンスのJSONパースに失敗: ${jsonError.message}`);
        }
        
        // データ構造の検証
        if (!sttResult) {
          throw new Error("STTレスポンスが空です");
        }
        
        // エラーチェック
        if (sttResult.error) {
          console.warn("STTエラーレスポンス:", sttResult.error);
          throw new Error(`音声認識エラー: ${sttResult.error}`);
        }
        
        // text プロパティの検証 (client.jsと同様の堅牢性確保)
        let recognizedText;
        
        // ケース1: 新しい構造 - { text: "...", originalText: "...", success: true }
        if (sttResult.text && typeof sttResult.text === 'string' && sttResult.text.trim()) {
          recognizedText = sttResult.text;
        }
        // ケース2: 古い構造 - { stt: { text: "..." }, ... }
        else if (sttResult.stt && sttResult.stt.text && typeof sttResult.stt.text === 'string' && sttResult.stt.text.trim()) {
          recognizedText = sttResult.stt.text;
        }
        // ケース3: その他の構造 または 空テキスト - エラー
        else {
          console.warn("無効なSTTレスポンス構造:", {
            hasText: !!sttResult.text,
            textType: typeof sttResult.text,
            textEmpty: sttResult.text === '',
            hasStt: !!sttResult.stt,
            sttType: typeof sttResult.stt,
            allKeys: Object.keys(sttResult)
          });
          throw new Error("STTレスポンスに有効なテキストが含まれていません");
        }
        
        // ログ用に元のテキストを保存
        console.info("認識結果（クリーニング前）:", recognizedText);
        
        // テキスト処理 - 不要なマーカーを削除
        let fixedText = recognizedText
          // 既存の置換
          .replace(/ご視聴ありがとうございました/g, 'ご回答ありがとうございました')
          // 「【質問】」などのマーカーを削除
          .replace(/【質問】|【回答】|【応答】|【返答】/g, '')
          // 角括弧内の指示的テキストを広範囲に削除
          .replace(/[【\[［][^】\]］]*[】\]］]/g, '')
          // 重複した句読点の整理
          .replace(/([。、．，！？!?])\1+/g, '$1')
          // 複数の空白を1つに
          .replace(/\s{2,}/g, ' ')
          // 前後の空白を削除
          .trim();
        
        console.info("認識結果（クリーニング後）:", fixedText);
        
        // 結果コールバックを呼び出し
        this.onResult(fixedText);
        
        // UI更新
        this._updateUI('認識完了', false);
        
        // 親ページのステータス表示を更新
        this._updateExternalStatus('🎧 どうぞお話しください…', false);
        
      } catch (error) {
        this._handleError(error);
      }
      
    } catch (error) {
      this._handleError(error);
    }
  }
  
  /**
   * UI更新
   * @private
   */
  _updateUI(message, isError) {
    if (!this.status) return;
    
    this.status.textContent = message;
    this.status.classList.toggle('error', isError);
    
    if (this.button) {
      this.button.classList.toggle('listening', this.isRecording);
      this.button.setAttribute('aria-label', this.isRecording ? '音声入力を停止' : '音声入力を開始');
      this.button.setAttribute('aria-pressed', this.isRecording ? 'true' : 'false');
    }
  }
  
  /**
   * エラー処理
   * @private
   */
  _handleError(error) {
    console.error('音声入力エラー:', error);
    
    // リソース解放
    this._cleanupResources();
    
    // ユーザーフレンドリーなエラーメッセージ
    let message = 'エラーが発生しました。もう一度お試しください。';
    
    if (error.name === 'NotAllowedError') {
      message = this.isIOS && this.isSafari 
        ? 'マイクへのアクセスを許可してください。iPhoneでは「許可」を選択後、再度お試しください。'
        : 'マイクの使用許可が必要です。';
    } 
    else if (error.name === 'NotFoundError') {
      message = 'マイクが見つかりません。';
    } 
    else if (error.name === 'NotReadableError' || error.name === 'AbortError') {
      message = 'マイクにアクセスできません。他のアプリが使用中かもしれません。';
    }
    else if (error.message && (error.message.includes('サーバーエラー') || error.message.includes('STT'))) {
      message = '音声認識サーバーとの通信に失敗しました。ネットワーク接続を確認してください。';
    }
    
    this._updateUI(message, true);
    
    // 親ページのステータス表示も更新
    this._updateExternalStatus('❌ ' + message, true);
  }
  
  /**
   * リソース解放
   * @private
   */
  _cleanupResources() {
    // タイマークリア
    Object.keys(this.timers).forEach(key => {
      if (this.timers[key]) {
        clearTimeout(this.timers[key]);
        this.timers[key] = null;
      }
    });
    
    // プロセッサ解放
    if (this.processor) {
      try {
        this.processor.disconnect();
        this.processor.onaudioprocess = null; // イベントハンドラをクリア
      } catch (e) {}
      this.processor = null;
    }
    
    // アナライザー解放
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (e) {}
      this.analyser = null;
    }
    
    // ゲインノード解放
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch (e) {}
      this.gainNode = null;
    }
    
    // ストリーム解放
    if (this.stream) {
      try {
        this.stream.getTracks().forEach(track => track.stop());
      } catch (e) {}
      this.stream = null;
    }
    
    // AudioContext解放
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    
    // レコーダー参照解放
    this.recorder = null;
    this.chunks = [];
    
    // 状態リセット
    this.isProcessing = false;
    this.isRecording = false;
    this.isSpeaking = false;
    this.hasStartedRecording = false;  // 録音開始フラグをリセット
    this.silenceCounter = 0;
    
    // visibilitychangeリスナーをクリア
    if (this._boundVisibilityChange) {
      document.removeEventListener('visibilitychange', this._boundVisibilityChange);
      this._boundVisibilityChange = null;
    }
  }
  
  /**
   * インスタンス破棄
   * @public
   */
  dispose() {
    if (this.isRecording) {
      this.stop();
    } else {
      this._cleanupResources();
    }
    
    if (this.button) {
      this.button.removeEventListener('click', this._boundClick); // 保持した関数参照を使用
    }
    
    this.container.innerHTML = '';
    this.isInitialized = false;
  }
}

// ESモジュールとしてエクスポート
export default PrecisionVoiceInput;