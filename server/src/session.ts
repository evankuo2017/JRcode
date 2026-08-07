import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ChatMessage, Problem, ServerEvent, TurnKind } from "./types.js";
import { streamChat, completeChat, RateLimitError } from "./llm.js";
import { interviewerSystemPrompt, observerDecisionPrompt, reflectionPrompt } from "./prompts.js";
import { logAgent } from "./logger.js";
import { Memory, buildSnapshotBlock, buildChatMessages, buildVisibleHistory, renderNarrative } from "./memory.js";

/** 觀察引擎參數 */
const OBSERVER_TICK_MS = 30_000; // 每 30 秒醒來檢查一次
const STALL_THRESHOLD_MS = 90_000; // 程式碼 90 秒沒動視為停滯
const INTERVENTION_COOLDOWN_MS = 150_000; // 介入後至少 2.5 分鐘不再介入
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000; // 觀察引擎撞到 429 後休息 5 分鐘

const OPENING_INSTRUCTION =
  "（系統訊息：面試開始。請依照開場流程向使用者打招呼並口語化介紹題目。）";
const CHECK_IN_INSTRUCTION =
  "（系統訊息：使用者已沉默一段時間。請用一句話輕聲關心進度，例如問他是否卡住，不要給任何提示。）";
const HINT_INSTRUCTION =
  "（系統訊息：使用者已停滯很久，請依提示階梯給「下一層」的提示，簡短口語，一次只給一個提示。）";

export class Session {
  readonly id = randomUUID();
  readonly problem: Problem;
  private readonly memory: Memory;
  private readonly systemPrompt: string;
  private sseClients = new Set<Response>();
  /** session 存活判斷用（有沒有分頁開著、多久沒任何動作）——跟「使用者是否卡關」是不同概念，不放進 Memory */
  private lastActivityAt = Date.now();

  // 串流/觀察狀態
  private currentAbort: AbortController | null = null;
  private streaming = false;
  private observerTimer: NodeJS.Timeout | null = null;
  private observerPausedUntil = 0;
  private openingSent = false;
  private reflectionCache: string | null = null;
  private readonly tag: string;

  constructor(problem: Problem) {
    this.problem = problem;
    this.memory = new Memory(problem);
    this.systemPrompt = interviewerSystemPrompt(problem);
    this.observerTimer = setInterval(() => void this.observerTick(), OBSERVER_TICK_MS);
    this.tag = this.id.slice(0, 8);
    logAgent(
      "system",
      `[${this.tag}] 新面試 session｜題目：${problem.title}（${problem.difficulty}）｜SYSTEM PROMPT`,
      this.systemPrompt
    );
  }

  // ---------- SSE ----------

  attachClient(res: Response): void {
    this.touch();
    this.sseClients.add(res);
    this.emit({ type: "problem", problem: this.problem });
    // 重連（重新整理、誤觸上一頁後回來）時重播對話記錄
    const history = buildVisibleHistory(this.memory);
    if (history.length > 0) {
      const payload: ServerEvent = { type: "history", items: history };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    res.on("close", () => this.sseClients.delete(res));
    // 第一個客戶端連上來時觸發開場白
    if (!this.openingSent) {
      this.openingSent = true;
      void this.runTurn(OPENING_INSTRUCTION, "opening");
    }
  }

  // ---------- 生命週期 ----------

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  hasClients(): boolean {
    return this.sseClients.size > 0;
  }

  inactiveMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  private emit(event: ServerEvent): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.sseClients) res.write(payload);
  }

  // ---------- 使用者輸入 ----------

  /** 使用者開始說話 → 立即中止進行中的輸出 */
  interrupt(): void {
    this.touch();
    this.memory.recordInterrupt();
    if (this.currentAbort) this.currentAbort.abort();
  }

  async userMessage(text: string): Promise<void> {
    this.touch();
    this.interrupt();
    await this.runTurn(text, "reply");
  }

  updateSnapshot(code: string, notes: string): void {
    this.touch();
    this.memory.recordCodeSnapshot(code);
    this.memory.recordNotesSnapshot(notes);
  }

  // ---------- 對話回合 ----------

  private async runTurn(trigger: string, kind: TurnKind): Promise<void> {
    // 等待前一輪確實結束（abort 是非同步生效的，稍等一下）
    if (this.streaming) await new Promise((r) => setTimeout(r, 100));

    const snapshotBlock = buildSnapshotBlock(this.memory);
    const llmUserContent = `${trigger}\n\n${snapshotBlock}`;
    const chatMessages: ChatMessage[] = [
      ...buildChatMessages(this.memory, this.systemPrompt),
      { role: "user", content: llmUserContent },
    ];

    this.streaming = true;
    this.currentAbort = new AbortController();
    this.emit({ type: "message_start", reason: kind });
    logAgent(
      "in",
      `[${this.tag}] AGENT ← 新 prompt（${kind}）｜歷史共 ${chatMessages.length} 則訊息`,
      llmUserContent
    );

    try {
      const { text, aborted, model } = await streamChat(
        chatMessages,
        (t) => this.emit({ type: "token", text: t }),
        this.currentAbort.signal
      );
      // 只在呼叫成功（無論有沒有被打斷）才寫入 Memory，失敗的呼叫不留任何痕跡，
      // 不再需要 v1 那種「呼叫失敗要把使用者那則訊息從 history pop 掉」的回滾邏輯
      this.memory.recordTurn({ kind, trigger, llmUserContent, assistantText: text, interrupted: aborted, model });
      this.emit({ type: "message_end", interrupted: aborted });
      logAgent(
        "out",
        `[${this.tag}] AGENT → 回應${aborted ? "（被使用者打斷）" : ""}｜模型：${model}`,
        text || "(沒有輸出任何文字)"
      );
    } catch (err) {
      const e = err as Error;
      logAgent("error", `[${this.tag}] AGENT ✗ 呼叫失敗`, e.message);
      this.emit({ type: "message_end", interrupted: true });
      this.emit({
        type: "notice",
        level: e instanceof RateLimitError ? "warn" : "error",
        text: e.message,
      });
      if (e instanceof RateLimitError) {
        this.observerPausedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      }
    } finally {
      this.streaming = false;
      this.currentAbort = null;
    }
  }

  // ---------- 沉默觀察引擎 ----------

  private async observerTick(): Promise<void> {
    const now = Date.now();
    if (this.streaming) return; // 正在對話中
    if (!this.openingSent) return;
    if (now < this.observerPausedUntil) return; // 429 冷卻中
    if (now - this.memory.lastInterventionAt() < INTERVENTION_COOLDOWN_MS) return;

    const idleMs = now - this.memory.lastEngagementAt();
    if (idleMs < STALL_THRESHOLD_MS) return;

    try {
      const decisionPrompt = observerDecisionPrompt({
        problem: this.problem,
        code: this.memory.latestCode(),
        notes: this.memory.latestNotes(),
        idleSeconds: idleMs / 1000,
        hints: this.memory.hints().map((t) => t.assistantText),
      });
      logAgent(
        "observer",
        `[${this.tag}] OBSERVER ← 決策 prompt（停滯 ${Math.round(idleMs / 1000)} 秒）`,
        decisionPrompt
      );
      const raw = await completeChat([{ role: "user", content: decisionPrompt }]);
      const { decision, reason } = this.parseDecision(raw);
      logAgent("observer", `[${this.tag}] OBSERVER → 決策：${decision}`, raw.trim() || "(空回應)");
      this.memory.recordStallCheck(idleMs, decision, reason);
      if (decision === "wait") return;

      const kind: TurnKind = decision === "check_in" ? "check_in" : "hint";
      await this.runTurn(kind === "check_in" ? CHECK_IN_INSTRUCTION : HINT_INSTRUCTION, kind);
    } catch (err) {
      // 觀察引擎失敗不打擾使用者；429 時進入冷卻
      if (err instanceof RateLimitError) {
        this.observerPausedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        this.emit({ type: "notice", level: "warn", text: err.message });
      }
    }
  }

  private parseDecision(raw: string): { decision: "wait" | "check_in" | "give_hint"; reason: string } {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return { decision: "wait", reason: "無法解析模型回應，預設觀望" };
      const obj = JSON.parse(match[0]) as { action?: string; reason?: string };
      if (obj.action === "check_in" || obj.action === "give_hint") {
        return { decision: obj.action, reason: obj.reason ?? "" };
      }
      return { decision: "wait", reason: obj.reason ?? "" };
    } catch {
      return { decision: "wait", reason: "解析失敗，預設觀望" };
    }
  }

  // ---------- 結束後反思 ----------

  async getReflection(): Promise<string> {
    if (this.reflectionCache) return this.reflectionCache;
    const narrative = renderNarrative(this.memory);
    const prompt = reflectionPrompt({ problem: this.problem, narrative });
    logAgent("system", `[${this.tag}] REFLECTION ← 完整時間軸`, narrative);
    const text = await completeChat([{ role: "user", content: prompt }]);
    logAgent("out", `[${this.tag}] REFLECTION →`, text);
    this.reflectionCache = text;
    return text;
  }

  dispose(): void {
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.currentAbort?.abort();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
  }
}

export const sessions = new Map<string, Session>();
