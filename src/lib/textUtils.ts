/**
 * lib/textUtils.ts —— 文本工具（公式检测等）
 *
 * 公式检测的正则不带 g 标志：全局正则的 .test() 会改变 lastIndex，
 * 连续调用结果会交替变化（经典坑），必须用非全局正则。
 */

/** 公式检测：常见数学符号 / LaTeX 标记 */
const FORMULA_RE =
  /[∑∫√∞πΔθλµ∂∇∈∉⊆∪∩±×÷=<>≈≠≤≥→←⇒⇔αβγδ]|\\(frac|sum|int|sqrt|infty|pi|theta|lambda|mu|partial|nabla|cdot|times|rightarrow|leftarrow|geq|leq)\b|\^\d|_\d/;

export function looksLikeFormula(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 3) return false;
  return FORMULA_RE.test(t);
}
