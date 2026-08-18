/** 檢查改版後 system prompt 的長度，以及實際跑一次開場看語氣 */
import { interviewerSystemPrompt } from "./src/prompts.js";
import type { Problem } from "./src/types.js";

const problem: Problem = {
  questionId: "1",
  title: "Two Sum",
  titleSlug: "two-sum",
  difficulty: "Easy",
  topicTags: ["Array", "Hash Table"],
  content:
    "<p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return indices of the two numbers such that they add up to <code>target</code>.</p>",
};

const system = interviewerSystemPrompt(problem);
console.log(`system prompt：${system.length} 字（改版前 1914 字）`);
console.log(`估計 ${Math.round(system.length / 1.5)} tokens\n`);

const BANNED = [
  "很好的問題",
  "好問題",
  "沒錯",
  "你說得對",
  "太棒了",
  "讓我們",
  "首先",
  "總結來說",
  "希望這對你有幫助",
  "當然可以",
];

const base = process.env.LLM_BASE_URL?.replace(/\/v1\/?$/, "") ?? "http://localhost:62315";
const model = process.env.LLM_MODEL ?? "qwen3-coder:30b";

const HISTORY = [
  { role: "user", content: "（系統訊息：面試開始。請依照開場流程向使用者打招呼並口語化介紹題目。）" },
  { role: "assistant", content: "你好，我是今天的面試官。這題要你在一個整數陣列裡找出兩個數字，加起來等於某個目標值，回傳它們的索引。舉例來說，輸入是 2、7、11、15，目標是 9，答案就是 0 跟 1。有問題隨時問我，思路可以寫在左邊。" },
  { role: "user", content: "喔好，那我想一下" },
  { role: "assistant", content: "嗯哼。" },
];

async function ask(userContent: string, label: string, withHistory = false) {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        ...(withHistory ? HISTORY : []),
        { role: "user", content: userContent },
      ],
      stream: false,
      options: { num_ctx: 8192 },
    }),
  });
  const j = (await res.json()) as any;
  const text = String(j.message?.content ?? "").trim();
  console.log(`── ${label}（${Date.now() - t0} ms）`);
  console.log(text);
  const hits = BANNED.filter((b) => text.includes(b));
  const md = /[*#`]|^\s*[-•]\s/m.test(text);
  console.log(`   禁用詞：${hits.length ? "✗ " + hits.join("、") : "✓ 無"}｜markdown：${md ? "✗ 有" : "✓ 無"}｜${text.length} 字\n`);
}

const snapshot =
  "\n\n<snapshot_meta>\n程式碼：還沒開始寫\n筆記：還是空的\n</snapshot_meta>\n" +
  "<current_code>\n(空白)\n</current_code>\n<current_notes>\n(空白)\n</current_notes>";

await ask("我想說可不可以用兩層for迴圈，每個都去找後面有沒有加起來等於target的" + snapshot, "回應暴力解", true);
await ask("那我是不是可以用一個字典把看過的數字都存起來" + snapshot, "他想到雜湊表", true);
await ask("我想把這個lin test從第一個接電力走到最後一個，每次都反轉他的都指標" + snapshot, "語音辨識錯字（linked list／節點／指標）", true);
await ask("嗯" + snapshot, "他只哼了一聲", true);
