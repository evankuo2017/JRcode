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
  /**
   * 被打斷時，使用者實際「聽」到的內容（前端語音佇列已播出的部分）。
   * undefined 代表無從得知（純文字模式），視同 assistantText 全部已傳達。
   */
  heardText?: string;
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

/**
 * 找出 heardText 在原文中的結束位置。
 *
 * heardText 是 assistantText 經過語音清理（拿掉 markdown 記號、引號、程式碼區塊）後的前綴，
 * 不是原文的字面前綴。清理只做刪除、不改順序，所以用貪婪的子序列比對就能對回原文；
 * 對不上時提早結束，寧可低估使用者聽到的量，也不要謊報他聽過。
 */
function heardBoundary(full: string, heard: string): number {
  let i = 0;
  for (let j = 0; j < heard.length; j++) {
    while (i < full.length && full[i] !== heard[j]) i++;
    if (i >= full.length) return full.length;
    i++;
  }
  return i;
}

/**
 * 被打斷的回覆要拆成「他真的聽到的」跟「他沒聽到的」兩段講給模型聽。
 *
 * 直接把 assistantText 整段丟回去（就算附註「未說完」）會讓模型以為這些話都送達了，
 * 於是後續對話建立在一段對方根本沒聽過的內容上——這是打斷機制最容易出錯的地方。
 *
 * 但也不能反過來要求它一定要把沒說完的話補完：真人面試官被打斷時，會看對方講了什麼
 * 才決定要不要接回去。所以這裡只負責「告知事實」，補不補講交給模型自己判斷，
 * 並且明確要求主軸放在使用者現在說的內容上。
 */
const FOLLOW_UP_NOTE =
  "要不要把這段補回來由你自己判斷：回應的主軸是使用者現在說的話，" +
  "只有在這段資訊仍然影響他接下來的思路時才順勢帶回去，而且要接得自然，不要像在重播";

function renderAssistantTurn(t: TurnEvent): string {
  if (!t.interrupted) return t.assistantText;
  if (t.heardText === undefined) return `${t.assistantText}\n（此回覆被使用者打斷，未說完）`;

  const cut = heardBoundary(t.assistantText, t.heardText);
  const heard = t.assistantText.slice(0, cut).trim();
  const unheard = t.assistantText.slice(cut).trim();

  if (!unheard) return `${heard}\n（說到這裡使用者就接話了。）`;
  if (!heard) {
    return (
      `（你這則回覆還沒發出聲音，使用者就先開口了，他完全沒聽到：「${t.assistantText.trim()}」` +
      `——不要假設他知道這些內容。${FOLLOW_UP_NOTE}）`
    );
  }
  return (
    `${heard}\n（你接下來正要說「${unheard}」，但使用者在這裡打斷了你，這段話他沒有聽到，` +
    `不要假設他知道。${FOLLOW_UP_NOTE}）`
  );
}

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
    messages.push({ role: "assistant", content: renderAssistantTurn(t) });
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

/** 時間軸上的打斷註記——反思要看的是「他到底聽進去多少」，不只是「有沒有被打斷」 */
function interruptNote(e: TurnEvent): string {
  if (!e.interrupted) return "";
  if (e.heardText === undefined) return "（被打斷，未說完）";
  const cut = heardBoundary(e.assistantText, e.heardText);
  const unheard = e.assistantText.slice(cut).trim();
  if (!unheard) return "（說完後才被打斷）";
  const heard = e.assistantText.slice(0, cut).trim();
  return heard
    ? `（被打斷；使用者只聽到「${heard}」，後半段沒聽到）`
    : "（被打斷；使用者完全沒聽到這段）";
}

/** 把所有事件（不只對話輪次）依時間序轉成人類可讀的文字時間軸，給面試結束反思用 */
export function renderNarrative(memory: Memory): string {
  const start = memory.all()[0]?.at ?? Date.now();
  const lines = [`[00:00] 面試開始：${memory.problem.title}（${memory.problem.difficulty}）`];

  for (const e of memory.all()) {
    const t = fmtClock(e.at - start);
    switch (e.type) {
      case "turn":
        if (e.kind === "reply") lines.push(`[${t}] 使用者：「${e.trigger}」`);
        lines.push(`[${t}] ${TURN_LABEL[e.kind]}：「${e.assistantText}」${interruptNote(e)}`);
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
