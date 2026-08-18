import { useEffect, useRef, useState } from "react";

/** 面試官講話時，要聽到這麼多字才算真的被打斷（太短的「嗯」「對」是附和，不是打斷） */
const BARGE_IN_MIN_CHARS = 3;

/**
 * 靜默多久算「這段話講完了」。
 *
 * Chrome 只要你稍微停頓就給一個 final result，所以「嗯……我想一下……我覺得可以用雜湊表」
 * 會被切成三段。若每段都立刻送出，就變成三次發問、三次回覆、後面兩次各自打斷前一次。
 * 真人面試官是等你講完一段話才開口，所以這裡累積片段，靜下來才當成一次完整發言送出。
 */
const UTTERANCE_SILENCE_MS = 1000;

interface SpeechOptions {
  /** 面試官是不是還在講——只有講話中才需要打斷，也才需要防回音 */
  isAgentSpeaking: () => boolean;
  /** 這段辨識結果是不是喇叭回音（面試官自己的聲音） */
  isSelfEcho: (text: string) => boolean;
  /** 確認使用者真的在打斷面試官 */
  onBargeIn: () => void;
  /** 一段話辨識完成 */
  onFinalResult: (text: string) => void;
}

/**
 * Web Speech API 語音輸入（僅 Chrome 系瀏覽器可用）。
 * 注意：這個 API 在 Electron 中無法運作，是本專案採用純網頁架構的原因之一。
 *
 * 打斷判斷刻意不用 onspeechstart：那個事件只要偵測到「像人聲的音訊」就觸發，
 * 沒戴耳機時喇叭放出來的面試官聲音就會誤觸，變成面試官不停打斷自己。
 * 改成看辨識出來的文字：夠長、而且不是回音，才算使用者要說話。
 */
export function useSpeech({ isAgentSpeaking, isSelfEcho, onBargeIn, onFinalResult }: SpeechOptions) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<any>(null);
  const callbacksRef = useRef({ isAgentSpeaking, isSelfEcho, onBargeIn, onFinalResult });
  callbacksRef.current = { isAgentSpeaking, isSelfEcho, onBargeIn, onFinalResult };
  const shouldListenRef = useRef(false);
  /** 這一段連續發言已經打斷過了，不重複送 */
  const bargedRef = useRef(false);
  /** 已辨識完成、但還在等他是不是要繼續講的片段 */
  const pendingRef = useRef<string[]>([]);
  const silenceTimerRef = useRef<number | null>(null);

  /** 靜默夠久 → 他講完了 → 整段一起送出 */
  const flushUtterance = () => {
    silenceTimerRef.current = null;
    const text = pendingRef.current.join("").trim();
    pendingRef.current = [];
    if (text) callbacksRef.current.onFinalResult(text);
  };

  /** 任何說話跡象都把「講完了」的判定往後推 */
  const postponeFlush = () => {
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = window.setTimeout(flushUtterance, UTTERANCE_SILENCE_MS);
  };

  const discardPending = () => {
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    pendingRef.current = [];
  };

  useEffect(() => {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    const rec = new SR();
    rec.lang = "zh-TW";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e: any) => {
      const cb = callbacksRef.current;
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (!text) continue;
          if (cb.isSelfEcho(text)) continue; // 面試官自己的聲音，不能當成使用者發言送出去
          bargedRef.current = false; // 這句結束了，下一句重新判斷要不要打斷
          pendingRef.current.push(text); // 先累積，等他真的停下來才送
        } else {
          interimText += r[0].transcript;
        }
      }
      setInterim(interimText);
      // 不論是講完一句、還是還在講（interim），都代表他還在說話 → 延後「講完了」的判定
      if (pendingRef.current.length > 0 || interimText.trim()) postponeFlush();

      const candidate = interimText.trim();
      if (!candidate) {
        bargedRef.current = false;
        return;
      }
      if (
        !bargedRef.current &&
        candidate.length >= BARGE_IN_MIN_CHARS &&
        cb.isAgentSpeaking() &&
        !cb.isSelfEcho(candidate)
      ) {
        bargedRef.current = true;
        cb.onBargeIn();
      }
    };
    rec.onend = () => {
      setInterim("");
      bargedRef.current = false;
      // Chrome 會自動停止辨識；若使用者仍要聽就重啟
      if (shouldListenRef.current) {
        try {
          rec.start();
        } catch {
          setListening(false);
        }
      } else {
        setListening(false);
      }
    };
    rec.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        shouldListenRef.current = false;
        setListening(false);
        setSupported(false);
      }
    };

    recognitionRef.current = rec;
    return () => {
      shouldListenRef.current = false;
      discardPending();
      rec.stop();
    };
  }, []);

  const start = () => {
    if (!recognitionRef.current) return;
    shouldListenRef.current = true;
    try {
      recognitionRef.current.start();
      setListening(true);
    } catch {
      // 已在聆聽中
    }
  };

  const stop = () => {
    shouldListenRef.current = false;
    discardPending(); // 手動關麥或結束面試時，沒送出的殘句直接丟掉
    recognitionRef.current?.stop();
    setListening(false);
  };

  return { supported, listening, interim, start, stop };
}
