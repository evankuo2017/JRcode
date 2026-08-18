import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { useAgentStream } from "../hooks/useAgentStream";
import { useSpeech } from "../hooks/useSpeech";
import { useTTS } from "../hooks/useTTS";
import { endSession, getReflection, sendInterrupt, sendMessage, sendSnapshot } from "../api";
import { isEcho } from "../echo";
import ReflectionScreen from "../components/ReflectionScreen";
import type { Problem } from "../types";

const LANGUAGES = [
  { id: "python", label: "Python" },
  { id: "javascript", label: "JavaScript" },
  { id: "typescript", label: "TypeScript" },
  { id: "java", label: "Java" },
  { id: "cpp", label: "C++" },
];

const SNAPSHOT_DEBOUNCE_MS = 2000;

/** 面試官停止說話後，這段時間內的辨識結果仍要過回音檢查（喇叭餘音還在辨識器的緩衝裡） */
const ECHO_GRACE_MS = 1500;

/** 題目分頁僅供開發驗證用；正式情境下使用者只能從與面試官的對談中了解題目 */
const SHOW_PROBLEM_TAB = import.meta.env.DEV;

export default function Interview() {
  const navigate = useNavigate();
  const [sessionId] = useState(() => sessionStorage.getItem("sessionId"));
  const cachedProblem: Problem | null = (() => {
    try {
      return JSON.parse(sessionStorage.getItem("problem") ?? "null");
    } catch {
      return null;
    }
  })();

  const tts = useTTS();
  const { items, agentSpeaking, agentThinking, problem: streamedProblem, addUserMessage } =
    useAgentStream(sessionId, {
      onMessageStart: () => tts.reset(), // 新的一則回覆：閉嘴，並重新開始記「使用者聽到哪裡」
      onToken: tts.onToken,
      onMessageEnd: (interrupted) => (interrupted ? tts.cancel() : tts.onMessageEnd()),
    });
  const problem = streamedProblem ?? cachedProblem;

  // 面試官「輪到他」＝正在想、正在生成、或語音佇列還沒播完。
  // 三個都要算：語音落後 token 串流好幾秒，而思考期間畫面上什麼都還沒出現，
  // 少算任何一個都會在他還沒講完時就顯示「換你說了」。
  const agentBusy = agentThinking || agentSpeaking || tts.speaking;
  // 已經開口了才算「說話中」；還在想的時候要顯示成思考，不然使用者會以為當掉了
  const agentTalking = agentSpeaking || tts.speaking;
  const agentBusyRef = useRef(agentBusy);
  const agentIdleAtRef = useRef(0);
  if (agentBusyRef.current !== agentBusy) {
    agentBusyRef.current = agentBusy;
    if (!agentBusy) agentIdleAtRef.current = Date.now();
  }

  const [leftTab, setLeftTab] = useState<"notes" | "problem">("notes");
  const [notes, setNotes] = useState("");
  const [code, setCode] = useState("# 在這裡寫你的解答\n");
  const [language, setLanguage] = useState("python");
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 逐字稿預設隱藏——真實使用者練的是「聽」，逐字稿只是給想回看的人用的手動選項
  const [showTranscript, setShowTranscript] = useState(false);

  // 結束模擬後的反思畫面
  const [ending, setEnding] = useState(false);
  const [reflection, setReflection] = useState<string | null>(null);
  const [reflectionError, setReflectionError] = useState<string | null>(null);

  // 沒有 session 直接回首頁
  useEffect(() => {
    if (!sessionId) navigate("/");
  }, [sessionId, navigate]);

  // 離開守衛：攔截「上一頁」與關閉/重新整理分頁的誤觸
  useEffect(() => {
    if (!sessionId) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // 觸發瀏覽器原生的「確定要離開嗎」對話框
    };
    const onPopState = () => {
      const leave = window.confirm(
        "要離開面試頁嗎？\n面試不會結束，可以從首頁的「繼續面試」回來。"
      );
      if (!leave) {
        // 把被上一頁吃掉的歷史補回來，留在原地
        window.history.pushState(null, "", window.location.href);
      }
    };
    // 多塞一筆歷史，讓第一次按上一頁時先觸發 popstate 而不是直接離開
    window.history.pushState(null, "", window.location.href);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("popstate", onPopState);
    };
  }, [sessionId]);

  // 聊天自動捲到底
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  // 快照上報（debounce）
  const codeRef = useRef(code);
  const notesRef = useRef(notes);
  codeRef.current = code;
  notesRef.current = notes;
  useEffect(() => {
    if (!sessionId) return;
    const timer = setTimeout(() => {
      void sendSnapshot(sessionId, codeRef.current, notesRef.current);
    }, SNAPSHOT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [sessionId, code, notes]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !sessionId) return;
      tts.cancel(); // 使用者發言，面試官立刻閉嘴
      const heard = tts.spokenText(); // 先結算他聽到哪裡，再讓面試官接話
      addUserMessage(trimmed);
      // 送訊息前先帶上最新快照，確保 agent 看到的是當下的程式碼
      void sendSnapshot(sessionId, codeRef.current, notesRef.current).then(() =>
        sendMessage(sessionId, trimmed, heard)
      );
      setInput("");
    },
    [sessionId, addUserMessage, tts]
  );

  const speech = useSpeech({
    isAgentSpeaking: () => agentBusyRef.current,
    // 面試官還在講、或剛停不久時，麥克風可能收到喇叭的回音；把聽起來就是他自己剛講過的話濾掉
    isSelfEcho: (text) =>
      (agentBusyRef.current || Date.now() - agentIdleAtRef.current < ECHO_GRACE_MS) &&
      isEcho(text, tts.spokenText() ?? ""),
    onBargeIn: () => {
      tts.cancel(); // 你一開口，語音先停
      if (sessionId) void sendInterrupt(sessionId, tts.spokenText());
    },
    onFinalResult: (text) => submit(text),
  });

  const finish = async () => {
    if (!window.confirm("確定要結束這場面試嗎？結束後無法繼續。")) return;
    tts.cancel();
    speech.stop();
    setEnding(true);
    if (sessionId) {
      const result = await getReflection(sessionId);
      if ("reflection" in result) setReflection(result.reflection);
      else setReflectionError(result.error);
    } else {
      setReflectionError("找不到這場面試的 session。");
    }
  };

  const backToHome = async () => {
    if (sessionId) await endSession(sessionId);
    sessionStorage.clear();
    navigate("/");
  };

  if (ending) {
    return (
      <ReflectionScreen
        problem={problem}
        reflection={reflection}
        error={reflectionError}
        onClose={backToHome}
      />
    );
  }

  return (
    <div className="interview">
      <header className="topbar">
        <div className="topbar-title">
          {problem ? (
            <>
              <strong>{SHOW_PROBLEM_TAB ? problem.title : "模擬面試進行中"}</strong>
              <span className={`badge ${problem.difficulty.toLowerCase()}`}>
                {problem.difficulty}
              </span>
            </>
          ) : (
            "載入中…"
          )}
        </div>
        <div className="topbar-actions">
          {tts.supported && (
            <button
              className={`tts-btn ${tts.enabled ? "on" : ""}`}
              title={tts.enabled ? "關閉面試官語音" : "開啟面試官語音"}
              onClick={tts.toggle}
            >
              {tts.enabled ? "🔊 語音開" : "🔇 語音關"}
            </button>
          )}
          <button className="end-btn" onClick={finish}>
            結束模擬
          </button>
        </div>
      </header>

      <main className="panels">
        {/* 左：筆記 / 題目 */}
        <section className="panel left">
          <div className="tabs">
            <button
              className={leftTab === "notes" ? "active" : ""}
              onClick={() => setLeftTab("notes")}
            >
              筆記
            </button>
            {SHOW_PROBLEM_TAB && (
              <button
                className={leftTab === "problem" ? "active" : ""}
                onClick={() => setLeftTab("problem")}
              >
                題目（開發用）
              </button>
            )}
          </div>
          {leftTab === "notes" ? (
            <textarea
              className="notes"
              placeholder="把你的思路寫在這裡，面試官看得到…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          ) : (
            <div
              className="problem-content"
              dangerouslySetInnerHTML={{ __html: problem?.content ?? "" }}
            />
          )}
        </section>

        {/* 右：程式編輯器 */}
        <section className="panel right">
          <div className="editor-bar">
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <Editor
            height="100%"
            theme="vs-dark"
            language={language}
            value={code}
            onChange={(v) => setCode(v ?? "")}
            options={{
              fontSize: 14,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
            }}
          />
        </section>
      </main>

      {/* 下：對話區 */}
      <footer className="chat">
        <div className="chat-header">
          <button className="transcript-toggle" onClick={() => setShowTranscript((v) => !v)}>
            {showTranscript ? "隱藏逐字稿" : "顯示逐字稿"}
          </button>
        </div>
        {showTranscript ? (
          <div className="chat-log">
            {items.map((it) => (
              <div key={it.id} className={`msg ${it.role} ${it.level ?? ""}`}>
                {it.role === "assistant" && (
                  <span className="who">
                    面試官
                    {it.reason === "hint" ? "（主動提示）" : it.reason === "check_in" ? "（關心）" : ""}：
                  </span>
                )}
                {it.role === "user" && <span className="who">你：</span>}
                <span className="text">
                  {it.text}
                  {it.streaming && <span className="cursor">▍</span>}
                  {it.interrupted && <em className="interrupted">（被打斷）</em>}
                </span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <div
            className={`turn-indicator ${
              agentTalking
                ? "agent-speaking"
                : agentThinking
                  ? "agent-thinking"
                  : speech.listening
                    ? "user-turn"
                    : "idle"
            }`}
          >
            {agentTalking
              ? "🗣️ 面試官說話中"
              : agentThinking
                ? "🤔 面試官思考中"
                : speech.listening
                  ? "🎙️ 換你說了"
                  : "…"}
          </div>
        )}
        <div className="chat-input">
          <button
            className={`mic-btn ${speech.listening ? "on" : ""}`}
            title={
              speech.supported
                ? speech.listening
                  ? "停止語音輸入"
                  : "開始語音輸入"
                : "此瀏覽器不支援語音辨識，請改用 Chrome"
            }
            disabled={!speech.supported}
            onClick={() => (speech.listening ? speech.stop() : speech.start())}
          >
            {speech.listening ? "🎙️ 聆聽中" : "🎤"}
          </button>
          <input
            value={speech.interim || input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit(input);
            }}
            placeholder={
              speech.listening ? "說話中…（也可以直接打字）" : "跟面試官說點什麼…（Enter 送出）"
            }
          />
          <button className="send-btn" onClick={() => submit(input)}>
            送出
          </button>
        </div>
      </footer>
    </div>
  );
}
