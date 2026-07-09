import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { checkHealth, endSession, sessionExists, startSession } from "../api";

export default function Home() {
  const navigate = useNavigate();
  const [configError, setConfigError] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [difficulty, setDifficulty] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumableId, setResumableId] = useState<string | null>(null);

  useEffect(() => {
    checkHealth()
      .then((h) => {
        setConfigError(h.configError);
        setModel(h.model);
      })
      .catch(() => setConfigError("後端伺服器沒有回應，請確認 npm run dev 是否正常啟動。"));

    // 有進行中的面試（誤觸上一頁/重新整理跳回來）就提供繼續選項
    const existingId = sessionStorage.getItem("sessionId");
    if (existingId) {
      sessionExists(existingId).then((alive) => {
        if (alive) setResumableId(existingId);
        else sessionStorage.clear();
      });
    }
  }, []);

  const resume = () => navigate("/interview");

  const abandon = async () => {
    if (resumableId) await endSession(resumableId);
    sessionStorage.clear();
    setResumableId(null);
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { sessionId, problem, source } = await startSession(difficulty || undefined);
      sessionStorage.setItem("sessionId", sessionId);
      sessionStorage.setItem("problem", JSON.stringify(problem));
      sessionStorage.setItem("problemSource", source);
      navigate("/interview");
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  return (
    <div className="home">
      <h1>AI 模擬程式面試</h1>
      <p className="subtitle">由 AI 面試官陪你解一題 LeetCode，全程引導、不直接給答案。</p>

      <div className="rules">
        <h2>規則說明</h2>
        <ul>
          <li>按下「開始模擬」後，AI 面試官會抓一題 LeetCode 並向你介紹題目。</li>
          <li>畫面左側是<strong>筆記區</strong>（寫思路），右側是<strong>程式區</strong>（寫解答）。</li>
          <li>你可以用<strong>語音</strong>或打字隨時跟面試官對話、提問；你開口時會自動打斷他說話。</li>
          <li>面試官會默默觀察你的程式碼。你卡住太久時，他會主動關心或給漸進式提示。</li>
          <li>面試官的目標是引導你自己解出來，<strong>不會直接給答案</strong>。</li>
          <li>面試官會<strong>用語音即時回答你</strong>（可隨時在右上角關閉）。</li>
          <li>語音辨識僅支援 Chrome 系瀏覽器；第一次使用需允許麥克風權限。<strong>建議戴耳機</strong>，避免麥克風收到面試官的聲音造成誤打斷。</li>
        </ul>
      </div>

      {configError ? (
        <div className="notice error">{configError}</div>
      ) : (
        <p className="model-info">模型：{model || "…"}</p>
      )}
      {error && <div className="notice error">{error}</div>}

      {resumableId && (
        <div className="resume-row">
          <span>你有一場進行中的面試。</span>
          <button className="start-btn" onClick={resume}>
            繼續面試
          </button>
          <button className="abandon-btn" onClick={abandon}>
            放棄那場
          </button>
        </div>
      )}

      <div className="start-row">
        <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
          <option value="">隨機難度</option>
          <option value="Easy">Easy</option>
          <option value="Medium">Medium</option>
        </select>
        <button
          className="start-btn"
          onClick={start}
          disabled={starting || !!configError || !!resumableId}
        >
          {starting ? "正在準備題目…" : "開始模擬"}
        </button>
      </div>
    </div>
  );
}
