import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 依序嘗試 server/.env 與專案根目錄的 .env
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

export const config = {
  port: Number(process.env.PORT ?? 3001),
  apiKey: process.env.LLM_API_KEY ?? "",
  baseURL:
    process.env.LLM_BASE_URL ??
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  model: process.env.LLM_MODEL ?? "gemini-2.5-flash",
  ttsVoice: process.env.TTS_VOICE ?? "zh-TW-HsiaoChenNeural",
  dataDir: path.join(__dirname, "..", "data"),
};

export function assertConfigured(): string | null {
  if (!config.apiKey) {
    return "尚未設定 LLM_API_KEY。請複製 server/.env.example 為 server/.env 並填入你的 Gemini API key（https://aistudio.google.com/apikey）。";
  }
  return null;
}
