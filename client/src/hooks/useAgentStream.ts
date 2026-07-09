import { useEffect, useRef, useState } from "react";
import type { ChatItem, Problem, ServerEvent } from "../types";

let nextId = 1;

export interface StreamHandlers {
  onMessageStart?: () => void;
  onToken?: (text: string) => void;
  onMessageEnd?: (interrupted?: boolean) => void;
}

/** 連上 session 的 SSE，把事件整理成聊天訊息列表 */
export function useAgentStream(sessionId: string | null, handlers?: StreamHandlers) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const streamingIdRef = useRef<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/session/${sessionId}/stream`);

    es.onmessage = (e) => {
      const event = JSON.parse(e.data) as ServerEvent;
      switch (event.type) {
        case "problem":
          setProblem(event.problem);
          break;
        case "history":
          // 重連（重新整理/誤觸返回後回來）時重播完整對話記錄
          setItems(
            event.items.map((m) => ({
              id: nextId++,
              role: m.role,
              reason: m.reason,
              text: m.text,
            }))
          );
          break;
        case "message_start": {
          const id = nextId++;
          streamingIdRef.current = id;
          setAgentSpeaking(true);
          handlersRef.current?.onMessageStart?.();
          setItems((prev) => [
            ...prev,
            { id, role: "assistant", reason: event.reason, text: "", streaming: true },
          ]);
          break;
        }
        case "token":
          handlersRef.current?.onToken?.(event.text);
          setItems((prev) =>
            prev.map((it) =>
              it.id === streamingIdRef.current ? { ...it, text: it.text + event.text } : it
            )
          );
          break;
        case "message_end":
          setAgentSpeaking(false);
          handlersRef.current?.onMessageEnd?.(event.interrupted);
          setItems((prev) =>
            prev.map((it) =>
              it.id === streamingIdRef.current
                ? { ...it, streaming: false, interrupted: event.interrupted }
                : it
            )
          );
          streamingIdRef.current = null;
          break;
        case "notice":
          setItems((prev) => [
            ...prev,
            { id: nextId++, role: "notice", level: event.level, text: event.text },
          ]);
          break;
      }
    };

    return () => es.close();
  }, [sessionId]);

  const addUserMessage = (text: string) => {
    setItems((prev) => [...prev, { id: nextId++, role: "user", text }]);
  };

  return { items, agentSpeaking, problem, addUserMessage };
}
