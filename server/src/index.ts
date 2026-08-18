import express from "express";
import cors from "cors";
import { config, assertConfigured } from "./config.js";
import { getRandomProblem } from "./leetcode.js";
import { Session, sessions } from "./session.js";
import { synthesize } from "./tts.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/**
 * 健康檢查 + 設定檢查。前端首頁用來判斷能不能開始，
 * 並顯示「現在實際會用哪個模型」——模型全程由使用者的 .env 決定，不會被系統換掉。
 */
app.get("/api/health", (_req, res) => {
  const configError = assertConfigured();
  res.json({
    ok: !configError,
    configError,
    model: config.model,
    observerModel: config.observerModel,
    provider: config.provider,
  });
});

/** 開始模擬：抓題 → 建 session */
app.post("/api/session/start", async (req, res) => {
  const configError = assertConfigured();
  if (configError) {
    res.status(400).json({ error: configError });
    return;
  }
  const difficulty = req.body?.difficulty as "Easy" | "Medium" | "Hard" | undefined;
  const { problem, source } = await getRandomProblem(difficulty);
  const session = new Session(problem);
  sessions.set(session.id, session);
  res.json({ sessionId: session.id, problem, source });
});

/** 查詢 session 是否還存在（首頁「繼續面試」用） */
app.get("/api/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({ ok: true, problem: session.problem });
});

/** SSE 下行通道 */
app.get("/api/session/:id/stream", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  session.attachClient(res);
});

/** 使用者訊息（語音辨識結果或打字） */
app.post("/api/session/:id/message", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const text = String(req.body?.text ?? "").trim();
  if (!text) {
    res.status(400).json({ error: "empty message" });
    return;
  }
  void session.userMessage(text, heardOf(req.body)); // 回覆走 SSE，不等
  res.json({ ok: true });
});

/** 使用者開始說話 → 打斷模型輸出 */
app.post("/api/session/:id/interrupt", (req, res) => {
  sessions.get(req.params.id)?.interrupt(heardOf(req.body));
  res.json({ ok: true });
});

/** 前端回報的「使用者實際聽到的內容」；不是字串代表無從得知，交給 session 當作全部已傳達 */
function heardOf(body: unknown): string | null {
  const heard = (body as { heard?: unknown } | undefined)?.heard;
  return typeof heard === "string" ? heard : null;
}

/** 程式碼 + 筆記快照 */
app.post("/api/session/:id/snapshot", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  session.updateSnapshot(String(req.body?.code ?? ""), String(req.body?.notes ?? ""));
  res.json({ ok: true });
});

/** 面試結束後的自由格式反思（獨立於 DELETE，讓使用者在 session 銷毀前先讀到） */
app.post("/api/session/:id/reflection", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  try {
    const reflection = await session.getReflection();
    res.json({ reflection });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/** 文字轉語音（Edge TTS，免費免 key；前端逐句呼叫） */
app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text || text.length > 1000) {
    res.status(400).json({ error: "invalid text" });
    return;
  }
  try {
    const stream = await synthesize(text, config.ttsVoice);
    res.setHeader("Content-Type", "audio/mpeg");
    stream.pipe(res);
    stream.on("error", () => res.end());
  } catch {
    res.status(502).json({ error: "tts failed" });
  }
});

/** 結束模擬 */
app.delete("/api/session/:id", (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    session.dispose();
    sessions.delete(req.params.id);
  }
  res.json({ ok: true });
});

/**
 * 閒置 session 回收：分頁沒開著（無 SSE 連線）且 30 分鐘沒有任何活動
 * 就釋放（清掉計時器、對話歷史、快照）。防止使用者直接關分頁造成記憶體洩漏。
 */
const SESSION_IDLE_TTL_MS = 30 * 60_000;
setInterval(() => {
  for (const [id, session] of sessions) {
    if (!session.hasClients() && session.inactiveMs() > SESSION_IDLE_TTL_MS) {
      session.dispose();
      sessions.delete(id);
      console.log(`[server] 回收閒置 session ${id.slice(0, 8)}`);
    }
  }
}, 5 * 60_000);

const PROVIDER_LABEL: Record<typeof config.provider.kind, string> = {
  gemini: "Gemini 免費額度",
  local: "本機自架模型",
  custom: "自訂供應商",
};

app.listen(config.port, () => {
  console.log(`[server] http://localhost:${config.port}`);
  const configError = assertConfigured();
  if (configError) console.warn(`[server] ⚠ ${configError}`);
  console.log(
    `[server] 模型：${config.model}（${PROVIDER_LABEL[config.provider.kind]}：${config.provider.host}）`
  );
  if (config.observerModel !== config.model) {
    console.log(`[server] 觀察引擎另用：${config.observerModel}`);
  }
});
