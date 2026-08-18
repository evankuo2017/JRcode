import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 依序嘗試 server/.env 與專案根目錄的 .env
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

const baseURL = process.env.LLM_BASE_URL || GEMINI_BASE_URL;
const model = process.env.LLM_MODEL || "gemini-2.5-flash";

/** 後端跑在哪裡——決定前端要怎麼說明額度、以及沒設 key 時該提示什麼 */
export type ProviderKind = "gemini" | "local" | "custom";

function detectProvider(url: string): { kind: ProviderKind; host: string } {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // 網址格式不對就原樣顯示，讓使用者自己看出哪裡打錯
  }
  if (url.includes("generativelanguage.googleapis.com")) return { kind: "gemini", host };
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/.test(host) || /\.local(:|$)/.test(host)) {
    return { kind: "local", host };
  }
  return { kind: "custom", host };
}

const provider = detectProvider(baseURL);

export const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.LLM_API_KEY ?? "",
  baseURL,
  model,
  provider,
  /**
   * 觀察引擎的決策模型。預設「就是主模型」——不設定就不會有第二個模型出現。
   * 只有在 Gemini 免費額度下想省額度時才值得指定一個更便宜的模型。
   */
  observerModel: process.env.OBSERVER_MODEL || model,
  /** 面試官語音（Edge TTS，免費免 key） */
  ttsVoice: process.env.TTS_VOICE || "zh-TW-HsiaoChenNeural",
  dataDir: path.join(__dirname, "..", "data"),
};

/** 本機模型（Ollama 等）通常不驗證 key，所以只有雲端供應商才強制要求 */
export function assertConfigured(): string | null {
  if (config.provider.kind === "local") return null;
  if (config.apiKey) return null;
  return (
    "尚未設定 LLM_API_KEY。請複製 server/.env.example 為 server/.env 並填入免費的 Gemini API key" +
    "（https://aistudio.google.com/apikey）——或改把 LLM_BASE_URL 指向本機自架模型（見 local-llm 資料夾）。"
  );
}
