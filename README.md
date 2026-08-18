# JRcode — Junior's Realtime Coding Interview Coach

**給新手工程師的即時 AI 模擬程式面試。**

一位 AI 面試官陪你解 LeetCode：抓一題真題、口頭出題、引導你思考——**但不直接給答案**。你可以用語音或打字跟他對話；你埋頭寫程式時，他會默默觀察你的程式碼，卡太久才出手給漸進式提示。

- 左邊寫**筆記**、右邊是仿 LeetCode 的**程式編輯器**（Monaco，就是 VS Code 的編輯器核心）
- **雙向語音**：你用語音提問（Web Speech API），面試官也用語音即時回答（Edge TTS，逐句朗讀串流回覆）；你一開口就會打斷面試官說話。建議戴耳機避免回音誤觸發打斷
- 面試官口頭出題——**使用者看不到題目原文**，就像真實面試一樣，題目的完整樣貌要靠對答慢慢建立
- 自帶 API key：預設走 **Google Gemini 免費額度**，不用付一毛錢；也可以改接**本機自架模型**完全離線。伺服器終端機可即時觀測 agent 的每一次 prompt 與回應

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

**免費額度**：Flash 系列模型每天約 1,500 次請求（額度在太平洋時間午夜重置，約台灣時間下午 3–4 點）。正常一場模擬面試用不到 50 次請求。實際限制以 [官方文件](https://ai.google.dev/gemini-api/docs/rate-limits) 為準。

## 模型的選擇權在你手上

**JRcode 不會在面試進行到一半自動幫你換模型。** 你在 `server/.env` 設哪個模型，整場就是那個模型——面試官的語氣和判斷力不會毫無預警地變掉。

額度用完時（HTTP 429）畫面會直接告訴你，並列出三條路讓你自己選：等額度重置、改用別的模型或自己的 API key、或改用本機自架模型。觀察引擎同時會暫停 5 分鐘，避免空燒已經滿了的額度。

所有主流供應商都提供 OpenAI 相容端點，改 `server/.env` 兩行即可：

| 供應商 | LLM_BASE_URL | LLM_MODEL 範例 | 免費層 |
|---|---|---|---|
| Gemini（預設） | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` | ✅ 每天約 1,500 次 |
| **本機自架**（見 [local-llm/](local-llm/)） | `http://localhost:11434/v1` | `qwen3-coder:30b` | ✅ 完全免費、不限流量、離線可用 |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | ✅ 每天約 1,000 次 |
| OpenRouter | `https://openrouter.ai/api/v1` | 任一 `:free` 模型 | ✅ 多款免費模型 |
| OpenAI / 其他 | 各家端點 | 各家模型 | 付費 |

唯一的例外是選填的 `OBSERVER_MODEL`：想省 Gemini 額度的話，可以指定一顆更便宜的模型專門給沉默觀察引擎做判斷。**不設定就跟對話用同一顆**，本機自架模型維持不設定即可。

## 架構

```
client/  React + Vite + TypeScript（Chrome）
  ├─ pages/Home.tsx            首頁：規則說明 + 開始模擬
  ├─ pages/Interview.tsx       筆記/題目 | Monaco 編輯器 | 對話區
  ├─ hooks/useAgentStream.ts   SSE 接收面試官串流回覆
  ├─ hooks/useTTS.ts           逐句合成播放 + 追蹤「使用者實際聽到哪裡」
  ├─ hooks/useSpeech.ts        Web Speech API 語音輸入 + 開口打斷
  └─ echo.ts                   喇叭回音判定（避免面試官打斷自己）

server/  Node + Express + TypeScript
  ├─ src/session.ts            面試 session：對話輪次、打斷、沉默觀察引擎
  ├─ src/memory.ts             只增不改的事件流 + 四種讀取視圖
  ├─ src/prompts.ts            面試官人格 + 觀察引擎決策 + 反思 prompt
  ├─ src/llm.ts                OpenAI 相容 client（單一模型，不自動切換）
  ├─ src/leetcode.ts           LeetCode GraphQL 抓題 + 本地快取降級
  └─ src/index.ts              REST + SSE 路由
```

幾個設計重點：

- **打斷機制**：辨識到你講出足夠長度、且不是喇叭回音的內容 → 前端呼叫 `/interrupt` → 後端 abort 進行中的模型串流。關鍵在於前端會一併回報**你實際「聽」到哪裡**（語音落後文字串流好幾秒），後端據此把那則回覆拆成「聽到的」與「沒聽到的」兩段，面試官才不會以為整段話都傳達到了。
- **沉默觀察引擎**：每 30 秒檢查一次；程式碼超過 90 秒沒動才會呼叫模型判斷「觀望 / 關心一下 / 給提示」，每次介入後至少冷卻 2.5 分鐘——刻意保守，既像真人面試官，也省免費額度。
- **抓題降級**：LeetCode GraphQL 抓成功會順手快取成 JSON；抓失敗（改版/斷網）就從快取出題，最後還有內建保底題，離線也能玩。

## Roadmap

- [x] 面試官語音回覆（TTS，Edge TTS 神經網路語音）
- [x] 面試結束後的表現總結報告
- [ ] 英文面試模式（等中文版的 agent 機制穩定後再加）
- [ ] 在 UI 內設定 API key（免改 .env）
- [ ] 程式碼執行與測資驗證

## License

MIT
