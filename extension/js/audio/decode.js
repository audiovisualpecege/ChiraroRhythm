/**
 * decode.js — decodificação de áudio comprimido (AAC, MP3, OGG, FLAC...)
 * pelo decodificador nativo do Chromium embutido no CEP. Não usa ffmpeg nem
 * Media Encoder. O PCM das câmeras e dos WAV nem passa por aqui.
 */
(function (root) {
  async function decode(bytes, sampleRate) {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const rate = sampleRate && sampleRate >= 3000 && sampleRate <= 384000 ? sampleRate : 48000;
    const ctx = new OfflineAudioContext(1, 1, rate);
    let audio;
    try {
      audio = await ctx.decodeAudioData(ab);
    } catch (e) {
      throw new Error("o decodificador do Premiere não reconheceu este áudio");
    }
    const channelData = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channelData.push(audio.getChannelData(c));
    return { sampleRate: audio.sampleRate, channelData };
  }

  root.AEDecode = { decode };
})(window);
