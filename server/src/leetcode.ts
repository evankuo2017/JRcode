import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { Problem } from "./types.js";

/** 精選經典題單（免費題），隨機抽一題去 LeetCode 抓題敘 */
const SLUGS: { slug: string; difficulty: Problem["difficulty"] }[] = [
  { slug: "two-sum", difficulty: "Easy" },
  { slug: "valid-parentheses", difficulty: "Easy" },
  { slug: "merge-two-sorted-lists", difficulty: "Easy" },
  { slug: "best-time-to-buy-and-sell-stock", difficulty: "Easy" },
  { slug: "valid-anagram", difficulty: "Easy" },
  { slug: "binary-search", difficulty: "Easy" },
  { slug: "climbing-stairs", difficulty: "Easy" },
  { slug: "reverse-linked-list", difficulty: "Easy" },
  { slug: "linked-list-cycle", difficulty: "Easy" },
  { slug: "maximum-subarray", difficulty: "Medium" },
  { slug: "longest-substring-without-repeating-characters", difficulty: "Medium" },
  { slug: "3sum", difficulty: "Medium" },
  { slug: "container-with-most-water", difficulty: "Medium" },
  { slug: "product-of-array-except-self", difficulty: "Medium" },
  { slug: "group-anagrams", difficulty: "Medium" },
  { slug: "longest-palindromic-substring", difficulty: "Medium" },
  { slug: "coin-change", difficulty: "Medium" },
  { slug: "number-of-islands", difficulty: "Medium" },
  { slug: "top-k-frequent-elements", difficulty: "Medium" },
  { slug: "merge-intervals", difficulty: "Medium" },
];

const GRAPHQL_URL = "https://leetcode.com/graphql";
const QUERY = `
query questionData($titleSlug: String!) {
  question(titleSlug: $titleSlug) {
    questionId
    title
    titleSlug
    content
    difficulty
    exampleTestcases
    topicTags { name }
  }
}`;

const cacheDir = () => path.join(config.dataDir, "cache");

async function readCache(slug: string): Promise<Problem | null> {
  try {
    const raw = await fs.readFile(path.join(cacheDir(), `${slug}.json`), "utf8");
    return JSON.parse(raw) as Problem;
  } catch {
    return null;
  }
}

async function writeCache(problem: Problem): Promise<void> {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    await fs.writeFile(
      path.join(cacheDir(), `${problem.titleSlug}.json`),
      JSON.stringify(problem, null, 2),
      "utf8"
    );
  } catch {
    // 快取失敗不影響主流程
  }
}

async function fetchFromLeetCode(slug: string): Promise<Problem> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: `https://leetcode.com/problems/${slug}/`,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    },
    body: JSON.stringify({ query: QUERY, variables: { titleSlug: slug } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`LeetCode 回應 ${res.status}`);
  const json = (await res.json()) as {
    data?: { question?: any };
  };
  const q = json.data?.question;
  if (!q?.content) throw new Error("LeetCode 回應中沒有題目內容（可能是付費題或 schema 變動）");
  return {
    questionId: q.questionId,
    title: q.title,
    titleSlug: q.titleSlug,
    content: q.content,
    difficulty: q.difficulty,
    exampleTestcases: q.exampleTestcases,
    topicTags: (q.topicTags ?? []).map((t: { name: string }) => t.name),
  };
}

/** 內建保底題（完全離線時也能開始面試） */
const BUNDLED: Problem = {
  questionId: "1",
  title: "Two Sum",
  titleSlug: "two-sum",
  difficulty: "Easy",
  topicTags: ["Array", "Hash Table"],
  exampleTestcases: "[2,7,11,15]\n9",
  content:
    "<p>Given an array of integers <code>nums</code> and an integer <code>target</code>, return indices of the two numbers such that they add up to <code>target</code>.</p><p>You may assume that each input would have exactly one solution, and you may not use the same element twice.</p><p>You can return the answer in any order.</p><p><strong>Example 1:</strong></p><pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: Because nums[0] + nums[1] == 9, we return [0, 1].</pre>",
};

export async function getRandomProblem(
  difficulty?: Problem["difficulty"]
): Promise<{ problem: Problem; source: "live" | "cache" | "bundled" }> {
  const pool = difficulty ? SLUGS.filter((s) => s.difficulty === difficulty) : SLUGS;
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? SLUGS[0];

  try {
    const problem = await fetchFromLeetCode(pick.slug);
    await writeCache(problem);
    return { problem, source: "live" };
  } catch {
    // 降級 1：抽到的那題有快取就用
    const cached = await readCache(pick.slug);
    if (cached) return { problem: cached, source: "cache" };
    // 降級 2：任何一題有快取就用
    try {
      const files = await fs.readdir(cacheDir());
      const jsons = files.filter((f) => f.endsWith(".json"));
      if (jsons.length > 0) {
        const f = jsons[Math.floor(Math.random() * jsons.length)];
        const raw = await fs.readFile(path.join(cacheDir(), f), "utf8");
        return { problem: JSON.parse(raw) as Problem, source: "cache" };
      }
    } catch {
      // ignore
    }
    // 降級 3：內建保底題
    return { problem: BUNDLED, source: "bundled" };
  }
}

/** 給 LLM 看的純文字版題目（去除 HTML 標籤） */
export function problemAsText(p: Problem): string {
  const text = p.content
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return `題目：${p.title}（難度：${p.difficulty}，主題：${p.topicTags.join(", ")}）\n\n${text}`;
}
