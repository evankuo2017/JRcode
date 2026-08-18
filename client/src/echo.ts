/** 只留可比對的字元：文字與數字，標點空白一律忽略（辨識結果的標點跟 TTS 原文不會一致） */
const normalize = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

const NGRAM = 3;
/** 重疊比例超過這個值就判定為回音 */
const ECHO_RATIO = 0.6;
/** 太短的辨識結果沒有足夠證據判斷，一律當作使用者說的 */
const MIN_LEN = 5;

/**
 * 判斷一段語音辨識結果是不是喇叭回音（面試官自己的聲音被麥克風收回去）。
 *
 * 沒戴耳機時這件事一定會發生，而且後果比想像嚴重：回音會被當成使用者發言，
 * 面試官因此不斷打斷自己、甚至把自己剛講的話當成使用者的回答。
 *
 * 辨識會漏字錯字，所以不能用字串包含比對；改成把辨識結果切成 3-gram，
 * 看有多少比例出現在「面試官剛剛播出去的內容」裡。
 */
export function isEcho(recognized: string, spoken: string): boolean {
  const a = normalize(recognized);
  const b = normalize(spoken);
  if (a.length < MIN_LEN || b.length < NGRAM) return false;

  let hit = 0;
  let total = 0;
  for (let i = 0; i + NGRAM <= a.length; i++) {
    total++;
    if (b.includes(a.slice(i, i + NGRAM))) hit++;
  }
  return total > 0 && hit / total >= ECHO_RATIO;
}
