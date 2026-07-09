/** Agent 運作即時觀測：把每次送進模型的新 prompt 與模型回應印到終端機 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const COLORS = {
  in: "\x1b[36m", // 青色：送進 agent 的新內容
  out: "\x1b[32m", // 綠色：agent 的回應
  observer: "\x1b[33m", // 黃色：觀察引擎
  error: "\x1b[31m", // 紅色：錯誤
  system: "\x1b[35m", // 紫色：system prompt
} as const;

export function logAgent(
  kind: keyof typeof COLORS,
  label: string,
  body: string
): void {
  const color = COLORS[kind];
  const time = new Date().toLocaleTimeString("zh-TW", { hour12: false });
  console.log(
    `\n${color}┌─ ${label} ${DIM}${time}${RESET}\n` +
      body
        .split("\n")
        .map((line) => `${color}│${RESET} ${line}`)
        .join("\n") +
      `\n${color}└─${RESET}`
  );
}
