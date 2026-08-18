import { useCallback, useEffect, useRef, useState } from "react";

/** 句子結尾符號：湊滿一句就合成，讓語音跟上文字串流 */
const SENTENCE_END = /[。！？!?；;\n]/;
/** 單句合成的等待上限——後端卡住時不能連帶把整個播放迴圈鎖死 */
const FETCH_TIMEOUT_MS = 15_000;
/** 播放進度到這個比例就當整句都聽到了（尾音留白不算沒聽到） */
const FULLY_HEARD_RATIO = 0.95;

interface QueueItem {
  text: string;
  /** 送出合成請求的 Promise（預取：入列時就開始抓，播放時已就緒） */
  audio: Promise<Blob | null>;
  /** 中止這句的合成請求——cancel 時連還沒回來的預取一起收掉 */
  abort: AbortController;
}

const cleanText = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, "") // 多行程式碼區塊整段不唸
    .replace(/`([^`]*)`/g, "$1") // 行內反引號只去符號、保留內容
    .replace(/['"「」『』]/g, "") // 引號不唸，內容保留
    .replace(/[*#_~>]/g, "")
    .trim();

const fetchAudio = async (text: string, signal: AbortSignal): Promise<Blob | null> => {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null; // 逾時、中止、網路錯誤一律當作「這句拿不到音檔」
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
};

/**
 * 面試官即時語音。
 * 主要路徑：後端 /api/tts（Edge TTS 神經網路語音，中英數混讀自然）。
 * 降級路徑：瀏覽器內建 SpeechSynthesis（後端合成失敗時自動切換）。
 *
 * 兩個不變條件（違反任何一個都會讓語音「整場死掉」或讓面試官誤判使用者聽到了什麼）：
 * 1. 每個播放中的 Promise 都一定會 settle——被 cancel 中止也算，否則播放迴圈會永遠卡在 await。
 * 2. spokenText() 只累積「真的從喇叭出去」的文字，播到一半被打斷就只算前半段。
 */
export function useTTS() {
  const [enabled, setEnabled] = useState(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  /** 佇列還沒播完 —— 面試官「嘴巴還在動」的真實狀態，和 LLM 是否還在生成是兩回事 */
  const [speaking, setSpeaking] = useState(false);

  const bufferRef = useRef("");
  const queueRef = useRef<QueueItem[]>([]);
  const pumpingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 本輪播放的中止訊號：cancel 時 abort，讓所有進行中的等待「確實」結束 */
  const stopRef = useRef(new AbortController());
  const fallbackRef = useRef(false);
  /** 這則回覆已經播出去的文字——使用者真正聽到的內容 */
  const spokenRef = useRef("");
  /** 這則回覆有沒有發出過任何聲音（用來分辨「純文字模式」與「一個字都還沒聽到」） */
  const anySpokenRef = useRef(false);
  /**
   * 這則回覆已經被使用者打斷了，之後到達的 token 一律不再發聲。
   *
   * 沒有這個旗標的話：使用者開口 → cancel() 清空佇列 → 但後端的中止要跑一趟網路，
   * 這期間 SSE 上還在路上的 token 會繼續進 enqueue，面試官被打斷後又自己講了起來。
   * 由 reset()（下一則回覆開始）解除。
   */
  const suppressedRef = useRef(false);

  /** 記錄一句實際播了多少（ratio 0~1），每句只結算一次 */
  const commitSpoken = (text: string, ratio: number) => {
    if (ratio <= 0) return;
    anySpokenRef.current = true;
    spokenRef.current +=
      ratio >= FULLY_HEARD_RATIO ? text : text.slice(0, Math.floor(text.length * ratio));
  };

  const playBlob = (item: QueueItem, blob: Blob, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      let settled = false;
      const finish = (ratio: number) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        commitSpoken(item.text, ratio);
        resolve();
      };
      // pause() 不會觸發 ended，所以中止時必須自己把 Promise 收掉，否則播放迴圈永遠卡在這裡
      function onAbort() {
        const d = audio.duration;
        const ratio = Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0;
        audio.pause();
        finish(ratio);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => finish(1);
      audio.onerror = () => finish(0);
      void audio.play().catch(() => finish(0));
    });

  const speakBrowser = (item: QueueItem, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted || !("speechSynthesis" in window)) {
        resolve();
        return;
      }
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = "zh-TW";
      u.rate = 1.1;
      let settled = false;
      let charIndex = 0; // 瀏覽器回報的朗讀位置，用來估中止時聽到哪裡
      const ratioNow = () => (item.text.length > 0 ? charIndex / item.text.length : 0);
      const finish = (ratio: number) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        commitSpoken(item.text, ratio);
        resolve();
      };
      function onAbort() {
        window.speechSynthesis.cancel();
        finish(ratioNow());
      }
      signal.addEventListener("abort", onAbort, { once: true });
      u.onboundary = (e) => (charIndex = e.charIndex);
      u.onend = () => finish(1);
      u.onerror = () => finish(ratioNow());
      window.speechSynthesis.speak(u);
    });

  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    setSpeaking(true);
    try {
      while (enabledRef.current && queueRef.current.length > 0) {
        // 每輪重讀：cancel 之後會換成新世代的訊號，舊世代的句子自然被跳過
        const signal = stopRef.current.signal;
        const item = queueRef.current.shift()!;
        const blob = fallbackRef.current ? null : await item.audio;
        if (signal.aborted) continue;
        if (blob) {
          await playBlob(item, blob, signal);
        } else {
          fallbackRef.current = true; // 後端合成失敗，這則回覆剩下的都走瀏覽器語音
          await speakBrowser(item, signal);
        }
      }
    } finally {
      pumpingRef.current = false;
      setSpeaking(false);
    }
    // 收尾與 enqueue 之間有空隙，補一次檢查，避免剛入列的句子被晾在佇列裡沒人播
    if (enabledRef.current && queueRef.current.length > 0) void pump();
  }, []);

  const enqueue = useCallback(
    (sentence: string) => {
      const clean = cleanText(sentence);
      if (!clean) return;
      const abort = new AbortController();
      queueRef.current.push({
        text: clean,
        abort,
        audio: fallbackRef.current ? Promise.resolve(null) : fetchAudio(clean, abort.signal),
      });
      void pump();
    },
    [pump]
  );

  /** 接串流 token：湊滿一句就送進合成佇列 */
  const onToken = useCallback(
    (t: string) => {
      if (!enabledRef.current || suppressedRef.current) return;
      bufferRef.current += t;
      let idx: number;
      while ((idx = bufferRef.current.search(SENTENCE_END)) >= 0) {
        const sentence = bufferRef.current.slice(0, idx + 1);
        bufferRef.current = bufferRef.current.slice(idx + 1);
        enqueue(sentence);
      }
    },
    [enqueue]
  );

  /** 回覆結束：把最後不足一句的殘句唸完 */
  const onMessageEnd = useCallback(() => {
    if (!enabledRef.current || suppressedRef.current) {
      bufferRef.current = "";
      return;
    }
    if (bufferRef.current.trim()) enqueue(bufferRef.current);
    bufferRef.current = "";
  }, [enqueue]);

  /**
   * 立即閉嘴：中止播放與所有進行中的合成請求，並清空佇列。
   * 保留 spokenText()——呼叫端需要知道「使用者在被打斷前聽到了哪裡」。
   */
  const cancel = useCallback(() => {
    suppressedRef.current = true; // 這則回覆到此為止，後續 token 不再發聲
    bufferRef.current = "";
    for (const item of queueRef.current) item.abort.abort();
    queueRef.current = [];
    stopRef.current.abort(); // 同步觸發各個 finish()，播到一半的那句就在這裡結算
    stopRef.current = new AbortController();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  /** 新的一則回覆開始：閉嘴，並清掉上一則的「已聽到」紀錄 */
  const reset = useCallback(() => {
    cancel();
    suppressedRef.current = false; // 新的一則回覆，重新開口
    spokenRef.current = "";
    anySpokenRef.current = false;
    fallbackRef.current = false; // 每則回覆重新給後端一次機會，不因一次失敗就整場降級
  }, [cancel]);

  /**
   * 使用者實際聽到的內容。
   * null 代表這則回覆從頭到尾沒發出過聲音（語音關閉的純文字模式），視同全部已傳達；
   * 空字串代表語音是開的、但他一個字都還沒聽到就開口了。
   */
  const spokenText = useCallback(
    () => (!enabledRef.current && !anySpokenRef.current ? null : spokenRef.current),
    []
  );

  const toggle = useCallback(() => {
    cancel(); // 開或關都從乾淨狀態開始，不留半句殘留
    setEnabled((prev) => !prev);
  }, [cancel]);

  // 離開頁面時停止
  useEffect(() => () => cancel(), [cancel]);

  return {
    supported: true,
    enabled,
    speaking,
    toggle,
    onToken,
    onMessageEnd,
    cancel,
    reset,
    spokenText,
  };
}
