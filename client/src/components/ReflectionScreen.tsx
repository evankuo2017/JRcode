import type { Problem } from "../types";

interface Props {
  problem: Problem | null;
  reflection: string | null;
  error: string | null;
  onClose: () => void;
}

export default function ReflectionScreen({ problem, reflection, error, onClose }: Props) {
  const loading = reflection === null && error === null;

  return (
    <div className="reflection-screen">
      <div className="reflection-card">
        <h1>面試結束</h1>
        {problem && (
          <p className="reflection-meta">
            {problem.title}
            <span className={`badge ${problem.difficulty.toLowerCase()}`}>{problem.difficulty}</span>
          </p>
        )}

        {loading && <p className="reflection-loading">正在整理這場面試的回饋…</p>}
        {error && <div className="notice error">{error}</div>}
        {reflection && <p className="reflection-text">{reflection}</p>}

        <button className="start-btn" onClick={onClose}>
          回首頁
        </button>
      </div>
    </div>
  );
}
