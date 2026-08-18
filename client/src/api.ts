import type { Problem } from "./types";

export interface Health {
  ok: boolean;
  configError: string | null;
  model: string;
  observerModel: string;
  provider: { kind: "gemini" | "local" | "custom"; host: string };
}

export async function checkHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  return res.json();
}

export async function startSession(
  difficulty?: string
): Promise<{ sessionId: string; problem: Problem; source: string }> {
  const res = await fetch("/api/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ difficulty }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/session/${sessionId}`);
    return res.ok;
  } catch {
    return false;
  }
}

/** heard：使用者實際「聽」到的面試官語音內容；null 代表無從得知（純文字模式），後端視同全部已傳達 */
export function sendMessage(
  sessionId: string,
  text: string,
  heard: string | null = null
): Promise<Response> {
  return fetch(`/api/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, heard }),
  });
}

export function sendInterrupt(sessionId: string, heard: string | null = null): Promise<Response> {
  return fetch(`/api/session/${sessionId}/interrupt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ heard }),
  });
}

export function sendSnapshot(
  sessionId: string,
  code: string,
  notes: string
): Promise<Response> {
  return fetch(`/api/session/${sessionId}/snapshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, notes }),
  });
}

export function endSession(sessionId: string): Promise<Response> {
  return fetch(`/api/session/${sessionId}`, { method: "DELETE" });
}

export async function getReflection(
  sessionId: string
): Promise<{ reflection: string } | { error: string }> {
  try {
    const res = await fetch(`/api/session/${sessionId}/reflection`, { method: "POST" });
    return res.json();
  } catch {
    return { error: "無法連上伺服器，反思暫時無法產生。" };
  }
}
