export class BufferManager {
  constructor(options) {
    this.buffers = [];
    this.totalSamples = 0;
    this.isUsingOPFS = false;
    this.sampleRate = options.sampleRate;
    this.maxSamples = options.maxSamples;
    this.capabilities = options.capabilities;
    this.tempFileName = `audio_temp_${Date.now()}.bin`;
    this.opfsManager = {
      initialize: async () => {},
      saveFile: async () => {},
      appendToFile: async () => {},
      readFile: async () => new ArrayBuffer(0),
      deleteFile: async () => {},
      dispose: async () => {},
    };
    this.isUsingOPFS = this.capabilities.hasOPFS;
  }
  async initialize() {
    if (this.isUsingOPFS) {
      await this.opfsManager.initialize();
    }
  }
  async addBuffer(buffer) {
    if (this.totalSamples + buffer.length > this.maxSamples) {
      throw new Error('Buffer overflow: Maximum sample limit exceeded');
    }
    if (this.isUsingOPFS) {
      // ArrayBufferLikeをArrayBufferに変換
      const arrayBuffer =
        buffer.buffer instanceof ArrayBuffer
          ? buffer.buffer
          : new ArrayBuffer(buffer.buffer.byteLength);
      if (!(buffer.buffer instanceof ArrayBuffer)) {
        new Uint8Array(arrayBuffer).set(new Uint8Array(buffer.buffer));
      }
      await this.opfsManager.appendToFile(arrayBuffer, this.tempFileName);
    } else {
      this.buffers.push(new Float32Array(buffer));
    }
    this.totalSamples += buffer.length;
  }
  async getAllBuffers() {
    if (this.totalSamples === 0) {
      return new Float32Array(0);
    }
    if (this.isUsingOPFS) {
      const arrayBuffer = await this.opfsManager.readFile(this.tempFileName);
      return new Float32Array(arrayBuffer);
    } else {
      const merged = new Float32Array(this.totalSamples);
      let offset = 0;
      for (const buffer of this.buffers) {
        merged.set(buffer, offset);
        offset += buffer.length;
      }
      return merged;
    }
  }
  async reset() {
    this.buffers = [];
    this.totalSamples = 0;
    if (this.isUsingOPFS) {
      await this.opfsManager.deleteFile(this.tempFileName);
    }
  }
  async dispose() {
    await this.reset();
    if (this.isUsingOPFS) {
      await this.opfsManager.dispose();
    }
  }
  async saveToFile(merged) {
    if (this.isUsingOPFS) {
      // ArrayBufferLikeをArrayBufferに変換
      const arrayBuffer =
        merged.buffer instanceof ArrayBuffer
          ? merged.buffer
          : new ArrayBuffer(merged.buffer.byteLength);
      if (!(merged.buffer instanceof ArrayBuffer)) {
        new Uint8Array(arrayBuffer).set(new Uint8Array(merged.buffer));
      }
      await this.opfsManager.saveFile(arrayBuffer, this.tempFileName);
    }
  }
  getTotalSamples() {
    return this.totalSamples;
  }
}
//# sourceMappingURL=storage.js.map
