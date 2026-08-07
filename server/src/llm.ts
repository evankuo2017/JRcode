import OpenAI, { APIError } from "openai";
import { config } from "./config.js";
import { logAgent } from "./logger.js";
import type { ChatMessage } from "./types.js";

const client = new OpenAI({
  apiKey: config.apiKey || "unset",
  baseURL: config.baseURL,
});

export class RateLimitError extends Error {
  constructor(exhausted: string[]) {
    super(
      `所有模型都暫時無法使用（${exhausted.join(" → ")} 依序嘗試皆失敗）。` +
        `可能是免費額度用完——每日額度在太平洋時間午夜（台灣時間下午 3~4 點）重置，每分鐘限制稍等一兩分鐘就會恢復；` +
        `也可能是模型名稱已失效，請檢查 server/.env 裡的 LLM_MODEL / LLM_FALLBACK_MODELS / OBSERVER_MODEL 是否為供應商目前仍支援的名稱。`
    );
    this.name = "RateLimitError";
  }
}

function translateError(err: unknown): Error {
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      return new Error("API key 無效或沒有權限，請檢查 server/.env 裡的 LLM_API_KEY。");
    }
    return new Error(`模型服務回傳錯誤（${err.status}）：${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 模型備援鏈：Gemini 每個模型的免費額度分開計算，
 * 主模型撞到 429（額度用完）或 404（模型名稱失效/已下架）就自動切下一個，
 * 出過問題的模型冷卻一段時間不再嘗試。
 */
const EXHAUST_COOLDOWN_MS = 5 * 60_000;
const exhaustedUntil = new Map<string, number>();

function isRetryableError(err: unknown): err is APIError {
  return err instanceof APIError && (err.status === 429 || err.status === 404);
}

function availableModels(chain: string[]): string[] {
  const now = Date.now();
  return chain.filter((m) => (exhaustedUntil.get(m) ?? 0) < now);
}

function markExhausted(model: string, status: number | undefined): void {
  exhaustedUntil.set(model, Date.now() + EXHAUST_COOLDOWN_MS);
  const label = status === 429 ? "撞到 429 額度上限" : `回應 ${status}（模型名稱可能已失效）`;
  logAgent("error", `模型 ${model} ${label}`, `冷卻 ${EXHAUST_COOLDOWN_MS / 60000} 分鐘後才會再嘗試這個模型`);
}

const mainChain = [config.model, ...config.fallbackModels];

/**
 * 串流呼叫（含自動模型備援）。每收到一段文字呼叫 onToken；回傳完整文字與實際使用的模型。
 * 以 AbortSignal 中止時不視為錯誤，回傳已產出的部分。
 */
export async function streamChat(
  messages: ChatMessage[],
  onToken: (text: string) => void,
  signal?: AbortSignal
): Promise<{ text: string; aborted: boolean; model: string }> {
  const candidates = availableModels(mainChain);
  if (candidates.length === 0) throw new RateLimitError(mainChain);

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
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
      if (isRetryableError(err) && full === "") {
        // 這個模型不能用（額度用完或名稱失效）且還沒輸出任何字 → 安全地換下一個模型重試
        markExhausted(model, err.status);
        if (i < candidates.length - 1) {
          logAgent("system", "自動切換備援模型", `${model} → ${candidates[i + 1]}（原因：HTTP ${err.status}）`);
          continue;
        }
        throw new RateLimitError(mainChain);
      }
      throw translateError(err);
    }
  }
  throw new RateLimitError(mainChain);
}

/** 非串流呼叫，用於觀察引擎的決策（獨立的便宜模型 + 同樣的備援邏輯）。 */
export async function completeChat(messages: ChatMessage[]): Promise<string> {
  const chain = [config.observerModel, ...mainChain.filter((m) => m !== config.observerModel)];
  const candidates = availableModels(chain);
  if (candidates.length === 0) throw new RateLimitError(chain);

  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const res = await client.chat.completions.create({ model, messages });
      return res.choices[0]?.message?.content ?? "";
    } catch (err) {
      if (isRetryableError(err)) {
        markExhausted(model, err.status);
        if (i < candidates.length - 1) {
          logAgent("system", "自動切換備援模型", `${model} → ${candidates[i + 1]}（原因：HTTP ${err.status}）`);
          continue;
        }
        throw new RateLimitError(chain);
      }
      throw translateError(err);
    }
  }
  throw new RateLimitError(chain);
}
