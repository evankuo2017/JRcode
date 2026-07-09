export interface Problem {
  questionId: string;
  title: string;
  titleSlug: string;
  content: string;
  difficulty: "Easy" | "Medium" | "Hard";
  exampleTestcases?: string;
  topicTags: string[];
}

export interface VisibleMessage {
  role: "user" | "assistant";
  reason?: "opening" | "reply" | "hint";
  text: string;
}

export type ServerEvent =
  | { type: "problem"; problem: Problem }
  | { type: "history"; items: VisibleMessage[] }
  | { type: "message_start"; reason: "opening" | "reply" | "hint" }
  | { type: "token"; text: string }
  | { type: "message_end"; interrupted?: boolean }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string };

export interface ChatItem {
  id: number;
  role: "user" | "assistant" | "notice";
  reason?: "opening" | "reply" | "hint";
  level?: "info" | "warn" | "error";
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
}
