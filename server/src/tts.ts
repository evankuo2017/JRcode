import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { Readable } from "node:stream";

/**
 * Edge TTS：微軟 Edge「大聲朗讀」背後的神經網路語音，免費、免 key。
 * 中英數混讀自然，適合面試官口語回覆。
 * 每次合成建立一條新的 WebSocket 連線（服務端不允許重用同一連線連續合成）。
 */
export async function synthesize(text: string, voice: string): Promise<Readable> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text);
  // 串流結束後關閉連線
  audioStream.on("end", () => tts.close());
  audioStream.on("error", () => tts.close());
  return audioStream;
}
