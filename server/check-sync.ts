/**
 * 同步機制驗證：起一個假的 OpenAI 相容伺服器，用真實的 Session 程式碼路徑跑三個情境。
 * 慢速吐 token（首字 600ms）才測得出「思考中」與「說話中」的差別。
 */
import http from "node:http";

const PORT = 4599;
process.env.LLM_BASE_URL = `http://127.0.0.1:${PORT}/v1`;
process.env.LLM_API_KEY = "fake";
process.env.LLM_MODEL = "fake-model";

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const parsed = JSON.parse(body || "{}");
    if (!parsed.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"action":"give_hint","reason":"測試"}' } }],
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const tokens = ["這題", "你可以", "先想想", "暴力解", "。"];
    await new Promise((r) => setTimeout(r, 600)); // 思考時間：第一個 token 之前的空白
    for (const t of tokens) {
      if (res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 150));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

const { Session } = await import("./src/session.js");
const problem = {
  questionId: "1",
  title: "Two Sum",
  titleSlug: "two-sum",
  content: "<p>test</p>",
  difficulty: "Easy" as const,
  topicTags: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假的 SSE 客戶端，把面試官送出的事件全部收起來 */
function makeClient() {
  const events: any[] = [];
  const res: any = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ": connected" 之類的非 JSON 行 */
          }
        }
      }
      return true;
    },
    on: () => {},
    end: () => {},
  };
  return { events, res };
}

/** message_start 與 message_end 必須嚴格配對，中間不能插進另一個 message_start */
function checkPairing(events: any[]): string | null {
  let open = 0;
  for (const e of events) {
    if (e.type === "message_start") {
      open++;
      if (open > 1) return "兩則回覆同時開著——SSE 通道被兩輪同時佔用";
    }
    if (e.type === "message_end") open--;
    if (open < 0) return "message_end 多於 message_start";
  }
  return null;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
  if (!ok) failed++;
};

await new Promise<void>((r) => fake.listen(PORT, () => r()));

// ───────────────────────── 情境 1：連續兩次發言，發話不得重疊 ─────────────────────────
{
  const s = new Session(problem);
  const { events, res } = makeClient();
  s.attachClient(res); // 觸發開場白
  await sleep(300); // 開場白還在「思考中」

  void s.userMessage("我想先講講我的想法"); // 開場白被打斷
  await sleep(300);
  void s.userMessage("等等，我改變主意了"); // 再打斷一次
  await sleep(2500);

  const err = checkPairing(events);
  check("情境1 發話不重疊", err === null, err ?? "message_start/end 嚴格配對");
  const starts = events.filter((e) => e.type === "message_start").length;
  check("情境1 至少有一則回覆真的說出口", starts >= 1, `${starts} 則`);
  s.dispose();
}

// ───────────────────────── 情境 2：排隊期間使用者開口 → 介入作廢 ─────────────────────────
{
  const s = new Session(problem);
  const { events, res } = makeClient();
  s.attachClient(res);
  await sleep(2000); // 等開場白講完
  const before = events.filter((e) => e.type === "message_start").length;

  const bornEpoch = (s as any).epoch; // 觀察引擎決策當下的世界
  s.interrupt("開場白我聽到這裡"); // 決策期間使用者開口 → epoch 前進
  const spoke = await (s as any).runTurn("（系統訊息：給提示）", "hint", bornEpoch);
  await sleep(1200);

  const after = events.filter((e) => e.type === "message_start").length;
  check("情境2 過期的介入被作廢", spoke === false, `runTurn 回傳 ${spoke}`);
  check("情境2 沒有多說一句話", after === before, `message_start ${before} → ${after}`);
  s.dispose();
}

// ───────────────────────── 情境 3：思考中被打斷 → 記憶不留痕跡 ─────────────────────────
{
  const s = new Session(problem);
  const { events, res } = makeClient();
  s.attachClient(res);
  await sleep(2000); // 開場白講完
  const turnsBefore = (s as any).memory.turns().length;

  const run = (s as any).runTurn("（系統訊息：關心一下）", "check_in");
  await sleep(200); // 還在思考，第一個 token 是 600ms 之後
  s.interrupt("");
  await run;
  await sleep(400);

  const turnsAfter = (s as any).memory.turns().length;
  const thinkingEvents = events.filter((e) => e.type === "thinking");
  check("情境3 思考中被打斷不寫入 Memory", turnsAfter === turnsBefore, `turns ${turnsBefore} → ${turnsAfter}`);
  check(
    "情境3 thinking 事件有開有關",
    thinkingEvents.length >= 2 && thinkingEvents[thinkingEvents.length - 1].active === false,
    `${thinkingEvents.length} 個 thinking 事件，最後一個 active=${thinkingEvents[thinkingEvents.length - 1]?.active}`
  );
  s.dispose();
}

fake.close();
console.log(failed === 0 ? "\n全部通過" : `\n${failed} 項未通過`);
process.exit(failed === 0 ? 0 : 1);
