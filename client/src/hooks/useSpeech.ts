import { useEffect, useRef, useState } from "react";

interface SpeechOptions {
  /** 使用者開始說話（用來打斷 agent 的輸出） */
  onSpeechStart: () => void;
  /** 一段話辨識完成 */
  onFinalResult: (text: string) => void;
}

/**
 * Web Speech API 語音輸入（僅 Chrome 系瀏覽器可用）。
 * 注意：這個 API 在 Electron 中無法運作，是本專案採用純網頁架構的原因之一。
 */
export function useSpeech({ onSpeechStart, onFinalResult }: SpeechOptions) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const recognitionRef = useRef<any>(null);
  const callbacksRef = useRef({ onSpeechStart, onFinalResult });
  callbacksRef.current = { onSpeechStart, onFinalResult };
  const shouldListenRef = useRef(false);

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

    rec.onspeechstart = () => callbacksRef.current.onSpeechStart();
    rec.onresult = (e: any) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) callbacksRef.current.onFinalResult(text);
        } else {
          interimText += r[0].transcript;
        }
      }
      setInterim(interimText);
    };
    rec.onend = () => {
      setInterim("");
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
    recognitionRef.current?.stop();
    setListening(false);
  };

  return { supported, listening, interim, start, stop };
}
