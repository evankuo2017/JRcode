import type { ChatMessage, Problem, TurnKind, VisibleMessage } from "./types.js";

interface BaseEvent {
  id: number;
  at: number;
}

export interface TurnEvent extends BaseEvent {
  type: "turn";
  kind: TurnKind;
  /** 使用者發言，或系統合成指令（開場/提示/關心） */
  trigger: string;
  /** trigger + 完整 <snapshot_meta>/<current_code>/<current_notes>，原始不動 */
  llmUserContent: string;
  assistantText: string;
  interrupted: boolean;
  model?: string;
}

export interface CodeSnapshotEvent extends BaseEvent {
  type: "code_snapshot";
  code: string;
}

export interface NotesSnapshotEvent extends BaseEvent {
  type: "notes_snapshot";
  notes: string;
}

export interface StallCheckEvent extends BaseEvent {
  type: "stall_check";
  idleMs: number;
  decision: "wait" | "check_in" | "give_hint";
  reason: string;
}

export interface InterruptEvent extends BaseEvent {
  type: "interrupt";
}

export type MemoryEvent =
  | TurnEvent
  | CodeSnapshotEvent
  | NotesSnapshotEvent
  | StallCheckEvent
  | InterruptEvent;

/**
 * 面試的完整記憶：只增不改的時間序事件陣列。
 * 事件一旦寫入永不刪除、永不覆寫——「省 token」只發生在讀取當下組給模型看的視圖，
 * 不是寫入時的動作（取代 v1 直接 mutate history 字串的做法）。
 */
export class Memory {
  private events: MemoryEvent[] = [];
  private nextId = 1;
  private readonly startedAt = Date.now();

  constructor(readonly problem: Problem) {}

  // ---------- 寫入 ----------

  recordTurn(t: Omit<TurnEvent, "id" | "at" | "type">): TurnEvent {
    const event: TurnEvent = { id: this.nextId++, at: Date.now(), type: "turn", ...t };
    this.events.push(event);
    return event;
  }

  recordCodeSnapshot(code: string): void {
    if (code === this.latestCode()) return; // 內容沒變就不重複記
    this.events.push({ id: this.nextId++, at: Date.now(), type: "code_snapshot", code });
  }

  recordNotesSnapshot(notes: string): void {
    if (notes === this.latestNotes()) return;
    this.events.push({ id: this.nextId++, at: Date.now(), type: "notes_snapshot", notes });
  }

  recordStallCheck(idleMs: number, decision: StallCheckEvent["decision"], reason: string): void {
    this.events.push({ id: this.nextId++, at: Date.now(), type: "stall_check", idleMs, decision, reason });
  }

  recordInterrupt(): void {
    this.events.push({ id: this.nextId++, at: Date.now(), type: "interrupt" });
  }

  // ---------- 查詢（純函式，不改狀態） ----------

  all(): readonly MemoryEvent[] {
    return this.events;
  }

  turns(): TurnEvent[] {
    return this.events.filter((e): e is TurnEvent => e.type === "turn");
  }

  latestCode(): string {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "code_snapshot") return e.code;
    }
    return "";
  }

  latestNotes(): string {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "notes_snapshot") return e.notes;
    }
    return "";
  }

  lastCodeChangeAt(): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "code_snapshot") return e.at;
    }
    return this.startedAt;
  }

  lastNotesChangeAt(): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "notes_snapshot") return e.at;
    }
    return this.startedAt;
  }

  lastUserActivityAt(): number {
    let latest = this.startedAt;
    for (const e of this.events) {
      if (e.type === "interrupt") latest = Math.max(latest, e.at);
      if (e.type === "turn" && e.kind === "reply") latest = Math.max(latest, e.at);
    }
    return latest;
  }

  /** 使用者最後一次「有在動」的時間——程式碼、筆記、發言取最晚 */
  lastEngagementAt(): number {
    return Math.max(this.lastCodeChangeAt(), this.lastNotesChangeAt(), this.lastUserActivityAt());
  }

  lastInterventionAt(): number {
    let latest = 0;
    for (const t of this.turns()) {
      if (t.kind === "hint" || t.kind === "check_in") latest = Math.max(latest, t.at);
    }
    return latest;
  }

  /** 所有提示（不像 v1 只留最後一個），供觀察引擎判斷下一層提示要給什麼 */
  hints(): TurnEvent[] {
    return this.turns().filter((t) => t.kind === "hint");
  }

  private lastTurnAt(): number {
    const turns = this.turns();
    return turns.length > 0 ? turns[turns.length - 1].at : this.startedAt;
  }

  codeChangedSinceLastTurn(): boolean {
    return this.lastCodeChangeAt() > this.lastTurnAt();
  }

  notesChangedSinceLastTurn(): boolean {
    return this.lastNotesChangeAt() > this.lastTurnAt();
  }
}

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分鐘前`;
}

/** 組 <snapshot_meta>/<current_code>/<current_notes> 區塊，純函式版的 v1 snapshotBlock() */
export function buildSnapshotBlock(memory: Memory, now = Date.now()): string {
  const code = memory.latestCode();
  const notes = memory.latestNotes();
  const codeMeta = code
    ? `最後更動於 ${fmtAge(now - memory.lastCodeChangeAt())}，自上次對話後${memory.codeChangedSinceLastTurn() ? "「有」新變動" : "沒有變動"}`
    : "還沒開始寫";
  const notesMeta = notes
    ? `最後更動於 ${fmtAge(now - memory.lastNotesChangeAt())}，自上次對話後${memory.notesChangedSinceLastTurn() ? "「有」新內容" : "沒有變動"}`
    : "還是空的";
  return (
    `<snapshot_meta>\n程式碼：${codeMeta}\n筆記：${notesMeta}\n</snapshot_meta>\n` +
    `<current_code>\n${code || "(空白)"}\n</current_code>\n` +
    `<current_notes>\n${notes || "(空白)"}\n</current_notes>`
  );
}

const FULL_FIDELITY_TURNS = 3; // 最近幾輪保留完整快照
const MAX_CONTEXT_TURNS = 60; // 只從送給模型的視圖裁掉最舊的，Memory 本身不受影響
const SNAPSHOT_BLOCK_RE = /<snapshot_meta>[\s\S]*?<\/current_notes>/;
const OMITTED_PLACEHOLDER = "（先前的程式碼與筆記快照已省略，最新狀態見最後一則訊息）";

/** 組送給模型的訊息陣列：system + 過去輪次（舊快照精簡）。呼叫端負責附加當前這一輪。 */
export function buildChatMessages(memory: Memory, systemPrompt: string): ChatMessage[] {
  const turns = memory.turns();
  const windowed = turns.length > MAX_CONTEXT_TURNS ? turns.slice(turns.length - MAX_CONTEXT_TURNS) : turns;
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  windowed.forEach((t, i) => {
    const isRecent = i >= windowed.length - FULL_FIDELITY_TURNS;
    const userContent = isRecent
      ? t.llmUserContent
      : t.llmUserContent.replace(SNAPSHOT_BLOCK_RE, OMITTED_PLACEHOLDER);
    messages.push({ role: "user", content: userContent });
    // 助理回覆文字永遠完整保留——提示階梯的歷史就藏在這裡，不需要額外機制去記
    messages.push({
      role: "assistant",
      content: t.interrupted ? `${t.assistantText}\n（此回覆被使用者打斷，未說完）` : t.assistantText,
    });
  });

  return messages;
}

/** 重連時重播給使用者看的對話記錄，從 turns() 投影出來，取代 v1 獨立維護的 visibleLog */
export function buildVisibleHistory(memory: Memory): VisibleMessage[] {
  const out: VisibleMessage[] = [];
  for (const t of memory.turns()) {
    if (t.kind === "reply") out.push({ role: "user", text: t.trigger });
    if (t.assistantText) out.push({ role: "assistant", reason: t.kind, text: t.assistantText });
  }
  return out;
}

function fmtClock(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const TURN_LABEL: Record<TurnKind, string> = {
  opening: "面試官開場白",
  reply: "面試官回覆",
  hint: "面試官給提示",
  check_in: "面試官（關心）",
};

/** 把所有事件（不只對話輪次）依時間序轉成人類可讀的文字時間軸，給面試結束反思用 */
export function renderNarrative(memory: Memory): string {
  const start = memory.all()[0]?.at ?? Date.now();
  const lines = [`[00:00] 面試開始：${memory.problem.title}（${memory.problem.difficulty}）`];

  for (const e of memory.all()) {
    const t = fmtClock(e.at - start);
    switch (e.type) {
      case "turn":
        if (e.kind === "reply") lines.push(`[${t}] 使用者：「${e.trigger}」`);
        lines.push(`[${t}] ${TURN_LABEL[e.kind]}：「${e.assistantText}」${e.interrupted ? "（被打斷，未說完）" : ""}`);
        break;
      case "code_snapshot":
        lines.push(`[${t}] 程式碼更新`);
        break;
      case "notes_snapshot":
        lines.push(`[${t}] 筆記更新`);
        break;
      case "stall_check":
        lines.push(`[${t}] 觀察引擎：停滯 ${Math.round(e.idleMs / 1000)} 秒 → 決定 ${e.decision}（理由：${e.reason}）`);
        break;
      case "interrupt":
        lines.push(`[${t}] 使用者開口打斷面試官`);
        break;
    }
  }

  lines.push(`[${fmtClock(Date.now() - start)}] 面試結束`);
  return lines.join("\n");
}
