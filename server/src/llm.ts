import OpenAI, { APIError } from "openai";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";

const client = new OpenAI({
  apiKey: config.apiKey || "unset",
  baseURL: config.baseURL,
});

export class RateLimitError extends Error {
  constructor() {
    super(
      "Gemini 免費額度已達上限（HTTP 429）。免費層的每日額度會在太平洋時間午夜（台灣時間下午 3~4 點）重置，稍後再試，或到 server/.env 換一把 key / 換一個供應商。"
    );
    this.name = "RateLimitError";
  }
}

function translateError(err: unknown): Error {
  if (err instanceof APIError) {
    if (err.status === 429) return new RateLimitError();
    if (err.status === 401 || err.status === 403) {
      return new Error("API key 無效或沒有權限，請檢查 server/.env 裡的 LLM_API_KEY。");
    }
    return new Error(`模型服務回傳錯誤（${err.status}）：${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 串流呼叫。每收到一段文字呼叫 onToken；回傳完整文字。
 * 以 AbortSignal 中止時不視為錯誤，回傳已產出的部分。
 */
export async function streamChat(
  messages: ChatMessage[],
  onToken: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; aborted: boolean }> {
  let full = "";
  try {
    const stream = await client.chat.completions.create(
      { model: config.model, messages, stream: true },
      { signal }
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onToken(delta);
      }
    }
    return { text: full, aborted: false };
  } catch (err) {
    if (signal?.aborted) return { text: full, aborted: true };
    throw translateError(err);
  }
}

/** 非串流呼叫，用於觀察引擎的決策。 */
export async function completeChat(messages: ChatMessage[]): Promise<string> {
  try {
    const res = await client.chat.completions.create({
      model: config.model,
      messages,
    });
    return res.choices[0]?.message?.content ?? "";
  } catch (err) {
    throw translateError(err);
  }
}
