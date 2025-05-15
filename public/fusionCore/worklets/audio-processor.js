// AudioWorkletProcessor for audio capture
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.bufferSize = 4096; // デフォルトバッファサイズ
    this.bufferIndex = 0;
    this.buffer = new Float32Array(this.bufferSize);

    // メインスレッドからのメッセージリスナー
    this.port.onmessage = event => {
      if (event.data.command === 'start') {
        this.isRecording = true;
        console.log('[AudioProcessor] Recording started');
      } else if (event.data.command === 'stop') {
        this.isRecording = false;
        console.log('[AudioProcessor] Recording stopped');
      } else if (event.data.command === 'setBufferSize') {
        this.bufferSize = event.data.size || 4096;
        this.buffer = new Float32Array(this.bufferSize);
        this.bufferIndex = 0;
        console.log(`[AudioProcessor] Buffer size set to ${this.bufferSize}`);
      }
    };

    console.log('[AudioProcessor] Initialized');
  }

  process(inputs, outputs, parameters) {
    // 録音中でなければ何もしない
    if (!this.isRecording) {
      return true;
    }

    // 入力データの取得（モノラルとして処理）
    const input = inputs[0];
    if (!input || !input.length) {
      return true;
    }

    const inputChannel = input[0];
    if (!inputChannel) {
      return true;
    }

    // バッファにデータを蓄積
    for (let i = 0; i < inputChannel.length; i++) {
      if (this.bufferIndex < this.bufferSize) {
        this.buffer[this.bufferIndex++] = inputChannel[i];
      }
    }

    // バッファが満杯になったらメインスレッドに送信
    if (this.bufferIndex >= this.bufferSize) {
      // バッファのコピーを作成して送信
      const bufferCopy = this.buffer.slice();
      this.port.postMessage({
        type: 'process',
        buffer: bufferCopy,
      });

      // バッファをリセット
      this.bufferIndex = 0;
    }

    // AudioWorkletProcessorを継続
    return true;
  }
}

// AudioWorkletProcessorを登録
registerProcessor('audio-processor', AudioProcessor);
