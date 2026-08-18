export interface Problem {
  questionId: string;
  title: string;
  titleSlug: string;
  content: string;
  difficulty: "Easy" | "Medium" | "Hard";
  exampleTestcases?: string;
  topicTags: string[];
}

export type TurnKind = "opening" | "reply" | "hint" | "check_in";

export interface VisibleMessage {
  role: "user" | "assistant";
  reason?: TurnKind;
  text: string;
}

export type ServerEvent =
  | { type: "problem"; problem: Problem }
  | { type: "history"; items: VisibleMessage[] }
  | { type: "thinking"; active: boolean }
  | { type: "message_start"; reason: TurnKind }
  | { type: "token"; text: string }
  | { type: "message_end"; interrupted?: boolean }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };

export interface ChatItem {
  id: number;
  role: "user" | "assistant" | "notice";
  reason?: TurnKind;
  level?: "info" | "warn" | "error";
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
}
