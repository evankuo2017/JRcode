# JRcode — Junior's Realtime Coding Interview Coach

**給新手工程師的即時 AI 模擬程式面試。**

一位 AI 面試官陪你解 LeetCode：抓一題真題、口頭出題、引導你思考——**但不直接給答案**。你可以用語音或打字跟他對話；你埋頭寫程式時，他會默默觀察你的程式碼，卡太久才出手給漸進式提示。

- 左邊寫**筆記**、右邊是仿 LeetCode 的**程式編輯器**（Monaco，就是 VS Code 的編輯器核心）
- **雙向語音**：你用語音提問（Web Speech API），面試官也用語音即時回答（SpeechSynthesis，逐句朗讀串流回覆）；你一開口就會打斷面試官說話。建議戴耳機避免回音誤觸發打斷
- 面試官口頭出題——**使用者看不到題目原文**，就像真實面試一樣，題目的完整樣貌要靠對答慢慢建立
- 自帶 API key：預設走 **Google Gemini 免費額度**，不用付一毛錢；伺服器終端機可即時觀測 agent 的每一次 prompt 與回應

## 快速開始

需求：[Node.js](https://nodejs.org/) 18+、Chrome 瀏覽器（語音輸入只有 Chrome 系支援）。

```bash
git clone <this-repo>
cd JRcode
npm install

# 設定 API key
cp server/.env.example server/.env
# 打開 server/.env，把 LLM_API_KEY 填上你的 Gemini key

npm run dev
```

然後用 **Chrome** 打開 http://localhost:5173 ，按「開始模擬」。

## 取得免費的 Gemini API Key

1. 到 [Google AI Studio](https://aistudio.google.com/apikey)（免綁信用卡）
2. 按「Create API key」
3. 把 key 貼進 `server/.env` 的 `LLM_API_KEY=`

**免費額度**：Flash 系列模型每天約 1,500 次請求（額度在太平洋時間午夜重置，約台灣時間下午 3–4 點）。正常一場模擬面試用不到 50 次請求。**額度用完時（HTTP 429），畫面會跳出提醒**，觀察引擎也會自動暫停 5 分鐘避免空燒額度。實際限制以 [官方文件](https://ai.google.dev/gemini-api/docs/rate-limits) 為準。

## 換其他模型供應商

所有主流供應商都提供 OpenAI 相容端點，改 `server/.env` 兩行即可：

| 供應商 | LLM_BASE_URL | LLM_MODEL 範例 | 免費層 |
|---|---|---|---|
| Gemini（預設） | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` | ✅ 每天約 1,500 次 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | ✅ 每天約 1,000 次 |
| OpenRouter | `https://openrouter.ai/api/v1` | 任一 `:free` 模型 | ✅ 多款免費模型 |
| Ollama（本機） | `http://localhost:11434/v1` | `llama3.1` 等 | ✅ 完全免費離線 |
| OpenAI / 其他 | 各家端點 | 各家模型 | 付費 |

## 架構

```
client/  React + Vite + TypeScript（Chrome）
  ├─ pages/Home.tsx            首頁：規則說明 + 開始模擬
  ├─ pages/Interview.tsx       筆記/題目 | Monaco 編輯器 | 對話區
  ├─ hooks/useAgentStream.ts   SSE 接收面試官串流回覆
  └─ hooks/useSpeech.ts        Web Speech API 語音輸入 + 開口打斷

server/  Node + Express + TypeScript
  ├─ src/session.ts            面試 session：對話歷史、打斷、沉默觀察引擎
  ├─ src/prompts.ts            面試官人格 + 觀察引擎決策 prompt
  ├─ src/llm.ts                OpenAI 相容 client（429 額度偵測）
  ├─ src/leetcode.ts           LeetCode GraphQL 抓題 + 本地快取降級
  └─ src/index.ts              REST + SSE 路由
```

幾個設計重點：

- **打斷機制**：語音辨識偵測到你開口 → 前端呼叫 `/interrupt` → 後端 abort 進行中的模型串流，已說出的部分保留在對話歷史並標註「被打斷」。
- **沉默觀察引擎**：每 30 秒檢查一次；程式碼超過 90 秒沒動才會呼叫模型判斷「觀望 / 關心一下 / 給提示」，每次介入後至少冷卻 2.5 分鐘——刻意保守，既像真人面試官，也省免費額度。
- **抓題降級**：LeetCode GraphQL 抓成功會順手快取成 JSON；抓失敗（改版/斷網）就從快取出題，最後還有內建保底題，離線也能玩。

## Roadmap

- [x] 面試官語音回覆（TTS，瀏覽器內建 SpeechSynthesis）
- [ ] 面試結束後的表現總結報告
- [ ] 在 UI 內設定 API key（免改 .env）
- [ ] 程式碼執行與測資驗證

## License

MIT
