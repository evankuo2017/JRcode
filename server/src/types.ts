export interface Problem {
  questionId: string;
  title: string;
  titleSlug: string;
  /** 題目敘述（HTML，來自 LeetCode） */
  content: string;
  difficulty: "Easy" | "Medium" | "Hard";
  exampleTestcases?: string;
  topicTags: string[];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type TurnKind = "opening" | "reply" | "hint" | "check_in";

export interface VisibleMessage {
  role: "user" | "assistant";
  reason?: TurnKind;
  text: string;
}

/** SSE 下行事件 */
export type ServerEvent =
  | { type: "problem"; problem: Problem }
  | { type: "history"; items: VisibleMessage[] }
  | { type: "thinking"; active: boolean }
  | { type: "message_start"; reason: TurnKind }
  | { type: "token"; text: string }
  | { type: "message_end"; interrupted?: boolean }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };
