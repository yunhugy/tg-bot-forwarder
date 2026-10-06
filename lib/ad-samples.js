// lib/ad-samples.js — 真实广告样本关键词库
//
// 来源：2026-10-05 真实命中的两条博彩广告（用户 6648773384，第一次被自动拉黑的样本）。
// 原文：
//   "不要去等明天，不要去相信永远，你所能做的，就是眼前。你所能做的，
//    就是让自己更快、更强。
//    南宫集团⚡️大量活动详情咨询
//    ➖➖➖➖➖➖➖➖
//    🧧首充100赠送88
//    🧧首充500赠送288
//    🧧首充1000赠送488
//    ➖➖➖➖➖➖➖➖
//    复制到浏览器打开即可👇
//    ⚡️   jhp70.top
//    ⚡️   sut56.top
//    ⚡️   f47uu.top
//    电子模拟器"
//
// 约束：
// - 命中即拉黑，只依据下面这些样本原文中的关键词，不做语义泛化、不猜新词。
// - 新增关键词必须来自真实命中的广告原文，并在此处注明来源日期。
// - 每次自动拉黑都会推送给管理员（见 relay.js），误伤可用 /unban 解除。
export const AD_SAMPLE_KEYWORDS = [
  '南宫集团',       // 样本中的博彩品牌名
  '首充',           // 样本中的"首充100赠送88"等；数字会变，取不变的词根
  '电子模拟器',     // 样本中的博彩术语
  '复制到浏览器打开', // 样本中的引流话术
];

/**
 * 检查文本是否命中样本关键词（字面包含匹配）。
 * @returns {{hit: boolean, keyword: string}} 命中时 keyword 为命中的关键词
 */
export function matchAdSample(text = '') {
  const raw = String(text || '');
  if (!raw.trim()) return { hit: false, keyword: '' };
  for (const kw of AD_SAMPLE_KEYWORDS) {
    if (kw && raw.includes(kw)) return { hit: true, keyword: kw };
  }
  return { hit: false, keyword: '' };
}
