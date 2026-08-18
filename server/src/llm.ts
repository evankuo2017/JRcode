import OpenAI, { APIError } from "openai";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";

const client = new OpenAI({
  apiKey: config.apiKey || "unset",
  baseURL: config.baseURL,
});

export type LlmErrorCode = "rate_limit" | "auth" | "not_found" | "unreachable" | "http";

/** 模型呼叫失敗。帶 code 是為了讓呼叫端能單獨處理額度用完（例如讓觀察引擎暫停）。 */
export class LlmError extends Error {
  constructor(
    readonly code: LlmErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** 額度用完時把三條路都講清楚——系統不幫使用者做決定 */
function rateLimitMessage(): string {
  if (config.provider.kind === "gemini") {
    return (
      `模型 ${config.model} 的免費額度暫時用完了。系統不會自動幫你換模型——你可以：` +
      `（1）等額度重置：每分鐘限制稍等一兩分鐘就恢復，每日額度在台灣時間下午 3~4 點重置；` +
      `（2）在 server/.env 的 LLM_MODEL 改用其他模型或填入你自己的付費 API key；` +
      `（3）改用本機自架模型（見專案的 local-llm 資料夾），完全不限流量。`
    );
  }
  return `模型 ${config.model} 回報額度不足（429）。請稍後再試，或在 server/.env 調整 LLM_MODEL / LLM_API_KEY。`;
}

function toLlmError(err: unknown): LlmError {
  if (err instanceof APIError) {
    if (err.status === 429) return new LlmError("rate_limit", rateLimitMessage());
    if (err.status === 401 || err.status === 403) {
      return new LlmError("auth", "API key 無效或沒有權限，請檢查 server/.env 裡的 LLM_API_KEY。");
    }
    if (err.status === 404) {
      return new LlmError(
        "not_found",
        `找不到模型 ${config.model}。請確認 server/.env 的 LLM_MODEL 是這個供應商目前支援的名稱` +
          (config.provider.kind === "local"
            ? "，本機模型請先用 ollama pull 下載並確認 ollama ps 看得到它。"
            : "。")
      );
    }
    return new LlmError("http", `模型服務回傳錯誤（${err.status}）：${err.message}`);
  }
  // 連不上（本機模型沒開、網址打錯、斷網）
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(err.message)) {
    return new LlmError(
      "unreachable",
      config.provider.kind === "local"
        ? `連不上本機模型服務（${config.baseURL}）。請確認 Ollama 正在執行（ollama ps），以及 server/.env 的 LLM_BASE_URL 位址正確。`
        : `連不上模型服務（${config.baseURL}）。請確認網路連線與 server/.env 的 LLM_BASE_URL。`
    );
  }
  return new LlmError("http", err instanceof Error ? err.message : String(err));
}

/**
 * 串流呼叫。每收到一段文字呼叫 onToken；回傳完整文字與實際使用的模型。
 * 以 AbortSignal 中止時不視為錯誤，回傳已產出的部分。
 *
 * 這裡刻意「不做」任何模型切換：使用者在 .env 設哪個模型就一直用哪個。
 * 面試進行到一半換模型會讓面試官的語氣與判斷力毫無預警地改變，
 * 額度用完應該是明確告知使用者，而不是靜悄悄降級。
 */
export async function streamChat(
  messages: ChatMessage[],
  onToken: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; aborted: boolean; model: string }> {
  const model = config.model;
  let full = "";
  try {
    const stream = await client.chat.completions.create(
      { model, messages, stream: true },
      { signal }
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onToken(delta);
      }
    }
    return { text: full, aborted: false, model };
  } catch (err) {
    if (signal?.aborted) return { text: full, aborted: true, model };
    throw toLlmError(err);
  }
}

/** 非串流呼叫。model 由呼叫端明確指定，不做隱含的模型選擇。 */
export async function completeChat(messages: ChatMessage[], model: string): Promise<string> {
  try {
    const res = await client.chat.completions.create({ model, messages });
    return res.choices[0]?.message?.content ?? "";
  } catch (err) {
    throw toLlmError(err);
  }
}
