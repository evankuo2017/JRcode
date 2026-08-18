import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { ChatMessage, Problem, ServerEvent, TurnKind } from "./types.js";
import { streamChat, completeChat, LlmError } from "./llm.js";
import { config } from "./config.js";
import { interviewerSystemPrompt, observerDecisionPrompt, reflectionPrompt } from "./prompts.js";
import { logAgent } from "./logger.js";
import { Memory, buildSnapshotBlock, buildChatMessages, buildVisibleHistory, renderNarrative } from "./memory.js";

/** 觀察引擎參數 */
const OBSERVER_TICK_MS = 30_000; // 每 30 秒醒來檢查一次
const SILENCE_MS = 90_000; // 使用者 90 秒沒開口視為沉默
const OUTPUT_IDLE_MS = 90_000; // 程式碼與筆記 90 秒都沒動視為沒在產出
const HEADS_DOWN_MS = 240_000; // 一直在寫但完全不出聲——不急，4 分鐘才提醒一次
const INTERVENTION_COOLDOWN_MS = 150_000; // 介入後至少 2.5 分鐘不再介入
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000; // 撞到額度上限後休息 5 分鐘

const OPENING_INSTRUCTION =
  "（系統訊息：面試開始。請依照開場流程向使用者打招呼並口語化介紹題目。）";
const CHECK_IN_INSTRUCTION =
  "（系統訊息：使用者已沉默一段時間。請用一句話輕聲關心進度，例如問他是否卡住，不要給任何提示。）";
const HEADS_DOWN_INSTRUCTION =
  "（系統訊息：使用者一直在寫程式，但很久沒有出聲。請用一句話請他講講現在的思路，不要給任何提示、也不要評論他的程式碼。）";
const HINT_INSTRUCTION =
  "（系統訊息：使用者已停滯很久，請依提示階梯給「下一層」的提示，簡短口語，一次只給一個提示。）";

const DISCARDED_REASON = "決定介入後、開口前使用者先講話了，此次介入作廢";

export class Session {
  readonly id = randomUUID();
  readonly problem: Problem;
  private readonly memory: Memory;
  private readonly systemPrompt: string;
  private sseClients = new Set<Response>();
  /** session 存活判斷用（有沒有分頁開著、多久沒任何動作）——跟「使用者是否卡關」是不同概念，不放進 Memory */
  private lastActivityAt = Date.now();

  /**
   * 面試官同時只做一件事：聆聽、思考、說話，三選一。
   *
   * 所有發話都排進這條鏈，前一輪真的結束才輪到下一輪——這是 SSE 通道與 Memory
   * 寫入的唯一入口。取代了舊版「等 100 毫秒然後不管前一輪結束沒就開始」的猜測式等待。
   */
  private turnChain: Promise<void> = Promise.resolve();
  /**
   * 使用者每開一次口就 +1。
   *
   * 面試官「決定要說什麼」跟「真的說出口」之間隔著一次模型呼叫（可能好幾秒），
   * 這期間使用者可能已經開口，原本要說的話就過期了——真人面試官聽到你講話，
   * 不會把準備好的台詞硬念出來，他會重想。比對 epoch 就是在做這件事。
   */
  private epoch = 0;
  /**
   * 還沒被回應就被蓋掉的使用者發言。
   * 面試官還沒開口就被打斷時，那一輪不寫入 Memory（見 executeTurn），
   * 但使用者說過的話不能憑空消失，留到下一輪一起考慮。
   */
  private droppedUserText: string[] = [];

  private currentAbort: AbortController | null = null;
  /** 思考中或說話中。這只是觀察引擎的快速早退，正確性不靠它——靠 turnChain 與 epoch */
  private busy = false;
  private observerTimer: NodeJS.Timeout | null = null;
  private observerPausedUntil = 0;
  private openingSent = false;
  /** 最近一次打斷帶來的「使用者聽到哪裡」，由當輪的 recordTurn 取用一次 */
  private pendingHeard: string | null = null;
  private reflectionCache: string | null = null;
  /** 使用者已按下結束：agent 停擺，但 session 還留著給反思讀 Memory */
  private finished = false;
  private disposed = false;
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

  /**
   * 使用者開口 → 面試官立刻停止思考或說話，轉為聆聽。
   *
   * heard：他在被打斷前實際「聽」到的內容（前端語音佇列已播出的部分）。
   * 語音落後 token 串流好幾秒，所以模型生成的文字不等於使用者聽到的文字——
   * 這個值會跟著這一輪寫進 Memory，避免面試官以為整段話都已經傳達到了。
   */
  interrupt(heard: string | null = null): void {
    this.touch();
    this.epoch += 1; // 在這之前啟動、還沒說出口的發話全部失效
    this.memory.recordInterrupt();
    if (heard !== null) this.pendingHeard = heard;
    this.currentAbort?.abort();
  }

  async userMessage(text: string, heard: string | null = null): Promise<void> {
    this.touch();
    this.interrupt(heard);
    await this.runTurn(text, "reply");
  }

  updateSnapshot(code: string, notes: string): void {
    this.touch();
    this.memory.recordCodeSnapshot(code);
    this.memory.recordNotesSnapshot(notes);
  }

  // ---------- 對話回合 ----------

  /**
   * 排入發話佇列。同一時間只會有一輪在跑。
   *
   * bornEpoch：這次發話的「理由」是在哪個 epoch 成立的。輪到它執行時 epoch 若已改變，
   * 代表使用者在排隊期間開過口，理由過期 → 整輪作廢，面試官不會說出一句遲到的話。
   * 使用者自己的發言不傳這個參數——他剛講的話永遠值得回應。
   *
   * 回傳 true 代表真的執行了，false 代表被作廢。
   */
  private runTurn(trigger: string, kind: TurnKind, bornEpoch?: number): Promise<boolean> {
    const queuedAt = Date.now();
    const run = this.turnChain.then(async () => {
      if (this.disposed || this.finished) return false; // 面試已結束，不再開口
      if (bornEpoch !== undefined && bornEpoch !== this.epoch) {
        logAgent(
          "observer",
          `[${this.tag}] OBSERVER ✗ 發話作廢（${kind}）`,
          "排隊期間使用者開口，原本的理由已經過期"
        );
        return false;
      }
      // 前面有沒被回應就被蓋掉的發言，跟這次一起講給面試官聽
      let merged = trigger;
      if (kind === "reply" && this.droppedUserText.length > 0) {
        merged = [...this.droppedUserText, trigger].join("\n");
        this.droppedUserText = [];
      }
      await this.executeTurn(merged, kind, Date.now() - queuedAt);
      return true;
    });
    this.turnChain = run.then(
      () => {},
      () => {} // 單輪失敗不能斷掉整條鏈
    );
    return run;
  }

  private async executeTurn(trigger: string, kind: TurnKind, queueWaitMs = 0): Promise<void> {
    const snapshotBlock = buildSnapshotBlock(this.memory);
    const llmUserContent = `${trigger}\n\n${snapshotBlock}`;
    const chatMessages: ChatMessage[] = [
      ...buildChatMessages(this.memory, this.systemPrompt),
      { role: "user", content: llmUserContent },
    ];

    this.busy = true;
    this.currentAbort = new AbortController();
    // 思考中：還沒有任何輸出，但使用者該知道面試官正在想
    this.emit({ type: "thinking", active: true });
    logAgent(
      "in",
      `[${this.tag}] AGENT ← 新 prompt（${kind}）｜歷史共 ${chatMessages.length} 則訊息`,
      llmUserContent
    );

    /** 第一個 token 才代表「他真的開口了」；在那之前被打斷等於什麼都沒發生 */
    let spoken = false;
    const askedAt = Date.now();
    let ttftMs = 0;
    const onToken = (t: string) => {
      if (!spoken) {
        spoken = true;
        ttftMs = Date.now() - askedAt;
        this.emit({ type: "thinking", active: false });
        this.emit({ type: "message_start", reason: kind });
      }
      this.emit({ type: "token", text: t });
    };

    try {
      const { text, aborted, model } = await streamChat(
        chatMessages,
        onToken,
        this.currentAbort.signal
      );
      // 打斷資訊只屬於這一輪，用過（或這輪根本沒被打斷）就清掉，不能延用到下一輪
      const heardText = this.pendingHeard ?? undefined;
      this.pendingHeard = null;

      if (!spoken) {
        // 思考中就被打斷（或模型一個字都沒吐）：對使用者而言這件事沒發生過，不留痕跡。
        // 但如果這輪是要回應使用者，他說過的話得留到下一輪，不能弄丟。
        if (kind === "reply") this.droppedUserText.push(trigger);
        this.emit({ type: "thinking", active: false });
        logAgent("out", `[${this.tag}] AGENT ✗ 還沒開口就被打斷（${kind}）`, "不寫入 Memory");
        return;
      }

      this.memory.recordTurn({
        kind,
        trigger,
        llmUserContent,
        assistantText: text,
        interrupted: aborted,
        heardText: aborted ? heardText : undefined,
        model,
      });
      this.emit({ type: "message_end", interrupted: aborted });
      logAgent(
        "out",
        `[${this.tag}] AGENT → 回應${aborted ? "（被使用者打斷）" : ""}｜模型：${model}` +
          // 思考＝排隊等前一輪結束 ＋ 模型吐出第一個字之前的時間。prompt 組裝是純字串運算，不到 1ms
          `｜思考 ${queueWaitMs + ttftMs} ms（排隊 ${queueWaitMs} + 模型首字 ${ttftMs}）`,
        text
      );
    } catch (err) {
      const rateLimited = err instanceof LlmError && err.code === "rate_limit";
      const message = (err as Error).message;
      logAgent("error", `[${this.tag}] AGENT ✗ 呼叫失敗`, message);
      this.emit({ type: "thinking", active: false });
      if (spoken) this.emit({ type: "message_end", interrupted: true });
      this.emit({ type: "notice", level: rateLimited ? "warn" : "error", text: message });
      // 額度用完就讓觀察引擎安靜一陣子，免得它繼續戳同一個已經滿了的額度
      if (rateLimited) this.observerPausedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
    } finally {
      this.busy = false;
      this.currentAbort = null;
    }
  }

  // ---------- 沉默觀察引擎 ----------

  private async observerTick(): Promise<void> {
    const now = Date.now();
    if (this.finished || this.disposed) return; // 面試已結束
    if (!this.hasClients()) return; // 沒有分頁開著，講給誰聽？（重新整理的空窗期跳過一拍即可）
    if (this.busy) return; // 正在思考或說話
    if (!this.openingSent) return;
    if (now < this.observerPausedUntil) return; // 額度冷卻中
    if (now - this.memory.lastInterventionAt() < INTERVENTION_COOLDOWN_MS) return;

    // 兩個獨立訊號。舊版把它們取 max 折疊成一個「還在動」，結果互相遮蔽：
    // 悶頭寫程式（不出聲）和光聊天不動手（沒產出）都會被誤判成健康狀態。
    const silentMs = now - this.memory.lastUserActivityAt();
    const outputIdleMs =
      now - Math.max(this.memory.lastCodeChangeAt(), this.memory.lastNotesChangeAt());

    const stuck = silentMs >= SILENCE_MS && outputIdleMs >= OUTPUT_IDLE_MS;
    const headsDown = silentMs >= HEADS_DOWN_MS && outputIdleMs < OUTPUT_IDLE_MS;
    // 有在講話但還沒動手，是正常的思考與釐清過程，不打擾
    if (!stuck && !headsDown) return;

    const bornEpoch = this.epoch;

    if (headsDown) {
      // 手一直在動、只是不出聲。不必花一次模型呼叫決定該不該介入——
      // 請他講講思路就好，而且永遠不會升級成提示。
      this.memory.recordStallCheck(silentMs, "check_in", "一直在寫程式但很久沒出聲");
      const spoke = await this.runTurn(HEADS_DOWN_INSTRUCTION, "check_in", bornEpoch);
      if (!spoke) this.memory.recordStallCheck(silentMs, "wait", DISCARDED_REASON);
      return;
    }

    // 兩邊都停了才是真的卡住。這時才值得花一次模型呼叫，決定要不要給、給到第幾層。
    const idleMs = Math.min(silentMs, outputIdleMs);
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
        `[${this.tag}] OBSERVER ← 決策 prompt（沒出聲 ${Math.round(silentMs / 1000)} 秒｜沒產出 ${Math.round(outputIdleMs / 1000)} 秒）`,
        decisionPrompt
      );
      const raw = await completeChat(
        [{ role: "user", content: decisionPrompt }],
        config.observerModel
      );
      const { decision, reason } = this.parseDecision(raw);
      logAgent("observer", `[${this.tag}] OBSERVER → 決策：${decision}`, raw.trim() || "(空回應)");
      this.memory.recordStallCheck(idleMs, decision, reason);
      if (decision === "wait") return;

      const kind: TurnKind = decision === "check_in" ? "check_in" : "hint";
      const spoke = await this.runTurn(
        kind === "check_in" ? CHECK_IN_INSTRUCTION : HINT_INSTRUCTION,
        kind,
        bornEpoch
      );
      if (!spoke) this.memory.recordStallCheck(idleMs, "wait", DISCARDED_REASON);
    } catch (err) {
      // 觀察引擎失敗不打擾使用者；額度用完時進入冷卻並告知一次
      if (err instanceof LlmError && err.code === "rate_limit") {
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

  // ---------- 結束 ----------

  /**
   * 使用者按下結束 → agent 立刻停止運作。
   *
   * session 本身要留著（反思得讀 Memory，而且結果會快取給重新整理用），
   * 但觀察引擎必須停擺：否則使用者在讀反思的時候，面試官會突然跳出來給提示，
   * 而且每 30 秒繼續醒來燒額度。正在講的那一輪也直接收掉。
   */
  stopAgent(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.observerTimer) {
      clearInterval(this.observerTimer);
      this.observerTimer = null;
    }
    this.currentAbort?.abort();
    this.emit({ type: "thinking", active: false });
    logAgent("system", `[${this.tag}] 面試結束`, "觀察引擎已停止，不再產生任何發話");
  }

  async getReflection(): Promise<string> {
    this.stopAgent(); // 先讓 agent 閉嘴，再回顧
    if (this.reflectionCache) return this.reflectionCache;
    // 面試官可能正講到一半被收掉，等佇列排空，否則那一輪還沒寫進 Memory，時間軸會缺最後一塊
    await this.turnChain;

    const narrative = renderNarrative(this.memory);
    const prompt = reflectionPrompt({ problem: this.problem, narrative });
    logAgent("system", `[${this.tag}] REFLECTION ← 完整時間軸`, narrative);
    // 反思是整場練習的產出，用主模型而不是觀察引擎那顆便宜模型
    const text = await completeChat([{ role: "user", content: prompt }], config.model);
    logAgent("out", `[${this.tag}] REFLECTION →`, text);
    this.reflectionCache = text;
    return text;
  }

  dispose(): void {
    this.stopAgent();
    this.disposed = true;
    if (this.observerTimer) clearInterval(this.observerTimer);
    this.currentAbort?.abort();
    for (const res of this.sseClients) res.end();
    this.sseClients.clear();
  }
}

export const sessions = new Map<string, Session>();
