import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ChatMessage, Problem, ServerEvent, VisibleMessage } from "./types.js";
import { streamChat, completeChat, RateLimitError } from "./llm.js";
import { interviewerSystemPrompt, observerDecisionPrompt } from "./prompts.js";
import { logAgent } from "./logger.js";

/** 觀察引擎參數 */
const OBSERVER_TICK_MS = 30_000; // 每 30 秒醒來檢查一次
const STALL_THRESHOLD_MS = 90_000; // 程式碼 90 秒沒動視為停滯
const INTERVENTION_COOLDOWN_MS = 150_000; // 介入後至少 2.5 分鐘不再介入
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000; // 觀察引擎撞到 429 後休息 5 分鐘

/** 對話歷史上限（含 system）：超過就丟最舊的回合，防止無限成長 */
const MAX_HISTORY_MESSAGES = 100;
/** 舊訊息裡的程式碼快照佔 token 大宗，每輪只保留最新一份 */
const SNAPSHOT_BLOCK_RE = /<current_code>[\s\S]*?<\/current_notes>/g;

export class Session {
  readonly id = randomUUID();
  readonly problem: Problem;
  private history: ChatMessage[] = [];
  /** 給使用者看的對話記錄（不含快照與系統指令），供重連時重播 */
  private visibleLog: VisibleMessage[] = [];
  private sseClients = new Set<Response>();
  private lastActivityAt = Date.now();

  // 快照狀態
  private code = "";
  private notes = "";
  private lastCodeChangeAt = Date.now();
  private lastUserActivityAt = Date.now();

  // 串流/觀察狀態
  private currentAbort: AbortController | null = null;
  private streaming = false;
  private observerTimer: NodeJS.Timeout | null = null;
  private lastInterventionAt = 0;
  private lastHint: string | null = null;
  private observerPausedUntil = 0;
  private openingSent = false;

  constructor(problem: Problem) {
    this.problem = problem;
    const systemPrompt = interviewerSystemPrompt(problem);
    this.history.push({ role: "system", content: systemPrompt });
    this.observerTimer = setInterval(() => void this.observerTick(), OBSERVER_TICK_MS);
    this.tag = this.id.slice(0, 8);
    logAgent(
      "system",
      `[${this.tag}] 新面試 session｜題目：${problem.title}（${problem.difficulty}）｜SYSTEM PROMPT`,
      systemPrompt
    );
  }

  private readonly tag: string;

  // ---------- SSE ----------

  attachClient(res: Response): void {
    this.touch();
    this.sseClients.add(res);
    this.emit({ type: "problem", problem: this.problem });
    // 重連（重新整理、誤觸上一頁後回來）時重播對話記錄
    if (this.visibleLog.length > 0) {
      const payload: ServerEvent = { type: "history", items: this.visibleLog };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    res.on("close", () => this.sseClients.delete(res));
    // 第一個客戶端連上來時觸發開場白
    if (!this.openingSent) {
      this.openingSent = true;
      void this.runTurn(
        "（系統訊息：面試開始。請依照開場流程向使用者打招呼並口語化介紹題目。）",
        "opening"
      );
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
    this.lastUserActivityAt = Date.now();
    if (this.currentAbort) this.currentAbort.abort();
  }

  async userMessage(text: string): Promise<void> {
    this.touch();
    this.lastUserActivityAt = Date.now();
    this.interrupt();
    this.visibleLog.push({ role: "user", text });
    const contextBlock = this.snapshotBlock();
    await this.runTurn(`${text}\n\n${contextBlock}`, "reply");
  }

  updateSnapshot(code: string, notes: string): void {
    this.touch();
    if (code !== this.code) this.lastCodeChangeAt = Date.now();
    this.code = code;
    this.notes = notes;
  }

  private snapshotBlock(): string {
    return `<current_code>\n${this.code || "(空白)"}\n</current_code>\n<current_notes>\n${this.notes || "(空白)"}\n</current_notes>`;
  }

  // ---------- 對話回合 ----------

  private async runTurn(
    userContent: string,
    reason: "opening" | "reply" | "hint"
  ): Promise<void> {
    // 等待前一輪確實結束（abort 是非同步生效的，稍等一下）
    if (this.streaming) await new Promise((r) => setTimeout(r, 100));

    // 控制記憶/token 成長：舊訊息裡的程式碼快照只保留說明文字，並限制歷史總長
    for (const msg of this.history) {
      if (msg.role === "user") {
        msg.content = msg.content.replace(
          SNAPSHOT_BLOCK_RE,
          "（先前的程式碼與筆記快照已省略，最新狀態見最後一則訊息）"
        );
      }
    }
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      // 保留 system(0) 與開場回合(1,2)，從最舊的一般回合開始丟
      this.history.splice(3, this.history.length - MAX_HISTORY_MESSAGES);
    }

    this.history.push({ role: "user", content: userContent });
    this.streaming = true;
    this.currentAbort = new AbortController();
    this.emit({ type: "message_start", reason });
    logAgent(
      "in",
      `[${this.tag}] AGENT ← 新 prompt（${reason}）｜歷史共 ${this.history.length} 則訊息`,
      userContent
    );

    try {
      const { text, aborted } = await streamChat(
        this.history,
        (t) => this.emit({ type: "token", text: t }),
        this.currentAbort.signal
      );
      this.history.push({
        role: "assistant",
        content: aborted ? `${text}\n（此回覆被使用者打斷，未說完）` : text,
      });
      if (text) this.visibleLog.push({ role: "assistant", reason, text });
      this.emit({ type: "message_end", interrupted: aborted });
      logAgent(
        "out",
        `[${this.tag}] AGENT → 回應${aborted ? "（被使用者打斷）" : ""}`,
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
      // 回捲這次失敗的 user turn，避免歷史裡出現沒有回應的訊息
      if (this.history[this.history.length - 1]?.role === "user") this.history.pop();
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
    if (now - this.lastInterventionAt < INTERVENTION_COOLDOWN_MS) return;

    const idleMs = now - Math.max(this.lastCodeChangeAt, this.lastUserActivityAt);
    if (idleMs < STALL_THRESHOLD_MS) return;

    try {
      const decisionPrompt = observerDecisionPrompt({
        problem: this.problem,
        code: this.code,
        notes: this.notes,
        idleSeconds: idleMs / 1000,
        lastHint: this.lastHint,
      });
      logAgent(
        "observer",
        `[${this.tag}] OBSERVER ← 決策 prompt（停滯 ${Math.round(idleMs / 1000)} 秒）`,
        decisionPrompt
      );
      const raw = await completeChat([{ role: "user", content: decisionPrompt }]);
      const decision = this.parseDecision(raw);
      logAgent(
        "observer",
        `[${this.tag}] OBSERVER → 決策：${decision}`,
        raw.trim() || "(空回應)"
      );
      if (decision === "wait") return;

      this.lastInterventionAt = Date.now();
      const instruction =
        decision === "check_in"
          ? "（系統訊息：使用者已沉默一段時間。請用一句話輕聲關心進度，例如問他是否卡住，不要給任何提示。）"
          : "（系統訊息：使用者已停滯很久，請依提示階梯給「下一層」的提示，簡短口語，一次只給一個提示。）";
      await this.runTurn(`${instruction}\n\n${this.snapshotBlock()}`, "hint");
      // 記下這次提示內容，供下次決策參考
      const last = this.history[this.history.length - 1];
      if (last?.role === "assistant") this.lastHint = last.content.slice(0, 200);
    } catch (err) {
      // 觀察引擎失敗不打擾使用者；429 時進入冷卻
      if (err instanceof RateLimitError) {
        this.observerPausedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        this.emit({ type: "notice", level: "warn", text: err.message });
      }
    }
  }

  private parseDecision(raw: string): "wait" | "check_in" | "give_hint" {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) return "wait";
      const obj = JSON.parse(match[0]) as { action?: string };
      if (obj.action === "check_in" || obj.action === "give_hint") return obj.action;
      return "wait";
    } catch {
      return "wait"; // 解析失敗一律當作觀望
    }
  }

  dispose(): void {
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.currentAbort?.abort();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
  }
}

export const sessions = new Map<string, Session>();
