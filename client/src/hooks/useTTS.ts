import { useCallback, useEffect, useRef, useState } from "react";

/** 句子結尾符號：湊滿一句就合成，讓語音跟上文字串流 */
const SENTENCE_END = /[。！？!?；;\n]/;

interface QueueItem {
  text: string;
  /** 送出合成請求的 Promise（預取：入列時就開始抓，播放時已就緒） */
  audio: Promise<Blob | null>;
}

/**
 * 面試官即時語音。
 * 主要路徑：後端 /api/tts（Edge TTS 神經網路語音，中英數混讀自然）。
 * 降級路徑：瀏覽器內建 SpeechSynthesis（後端合成失敗時自動切換）。
 */
export function useTTS() {
  const [enabled, setEnabled] = useState(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const bufferRef = useRef("");
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** 世代計數器：cancel 時 +1，讓進行中的播放迴圈失效 */
  const genRef = useRef(0);
  const fallbackRef = useRef(false);

  const cleanText = (text: string): string =>
    text
      .replace(/```[\s\S]*?```/g, "") // 多行程式碼區塊整段不唸
      .replace(/`([^`]*)`/g, "$1") // 行內反引號只去符號、保留內容
      .replace(/['"「」『』]/g, "") // 引號不唸，內容保留
      .replace(/[*#_~>]/g, "")
      .trim();

  const fetchAudio = async (text: string): Promise<Blob | null> => {
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob.size > 0 ? blob : null;
    } catch {
      return null;
    }
  };

  const speakBrowser = (text: string, gen: number): Promise<void> =>
    new Promise((resolve) => {
      if (!("speechSynthesis" in window) || gen !== genRef.current) {
        resolve();
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-TW";
      u.rate = 1.1;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });

  const playBlob = (blob: Blob, gen: number): Promise<void> =>
    new Promise((resolve) => {
      if (gen !== genRef.current) {
        resolve();
        return;
      }
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const done = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });

  const playLoop = useCallback(async () => {
    if (playingRef.current) return;
    playingRef.current = true;
    const gen = genRef.current;
    try {
      while (
        queueRef.current.length > 0 &&
        gen === genRef.current &&
        enabledRef.current
      ) {
        const item = queueRef.current.shift()!;
        const blob = fallbackRef.current ? null : await item.audio;
        if (gen !== genRef.current) break;
        if (blob) {
          await playBlob(blob, gen);
        } else {
          fallbackRef.current = true; // 後端合成失敗，之後這輪都走瀏覽器語音
          await speakBrowser(item.text, gen);
        }
      }
    } finally {
      playingRef.current = false;
    }
  }, []);

  const enqueue = useCallback(
    (sentence: string) => {
      const clean = cleanText(sentence);
      if (!clean) return;
      queueRef.current.push({
        text: clean,
        audio: fallbackRef.current ? Promise.resolve(null) : fetchAudio(clean),
      });
      void playLoop();
    },
    [playLoop]
  );

  /** 接串流 token：湊滿一句就送進合成佇列 */
  const onToken = useCallback(
    (t: string) => {
      if (!enabledRef.current) return;
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
    if (!enabledRef.current) {
      bufferRef.current = "";
      return;
    }
    if (bufferRef.current.trim()) enqueue(bufferRef.current);
    bufferRef.current = "";
  }, [enqueue]);

  /** 立即靜音並清空佇列（使用者開口打斷、送訊息、關閉語音時） */
  const cancel = useCallback(() => {
    genRef.current += 1;
    bufferRef.current = "";
    queueRef.current = [];
    audioRef.current?.pause();
    audioRef.current = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      if (prev) cancel();
      return !prev;
    });
  }, [cancel]);

  // 離開頁面時停止
  useEffect(() => () => cancel(), [cancel]);

  return { supported: true, enabled, toggle, onToken, onMessageEnd, cancel };
}
