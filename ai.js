// ai.js — AI 兜底识别的客户端一半：本机缓存 + 调服务端 + 「答案在不在这一页上」的判据
//
// 它解决的是一件本地规则做不到的事：把「AI研究算法工程师-智能语音方向」这种**完整**岗位名
// 从页面上认出来。规则层在语料上是 49%（岗位信息不丢），同一个提示词交给模型是 100%
// （见 README「换方案前的量测工具」）。所以规则先填、AI 后到、到不了就什么都不做。
//
// 缓存**只有本机这一层**（服务端刻意不缓存，理由见 server/src/core.js 的 AI_MAX_CALLS_PER_DAY）：
//   键    = shared.js 的 normalizeUrl(岗位链接)：去 #、去 utm_/追踪参数、host 小写去 www
//   校验  = 标题指纹：同一个链接换了岗位时只有标题能分辨（有的站把岗位 id 放在 # 后面，
//           规范化之后链接是一样的）
//   期限  = 60 天：标题没变但页面内容改了的唯一兜底
// 两个键都必须是**确定性**的：同一个页面每次都要算出同一个键。一旦带上时间戳或随机数，
// 缓存永远命不中 —— 那不是"缓存没生效"，是每次打开面板都白问一次模型（花钱 + 慢）。
//
// 为什么不跟别人共用缓存（曾经在服务端做过一层，1.4.1 删掉）：同一链接在不同人/不同设备上
// 未必是同一份内容（登录态、灰度、渲染时机、页面本身改了），拿别人的答案就是替用户拍板。
// 宁可多问几次模型 —— 同一台设备的重复访问由这一层挡住，钱花在"确实需要问"的那些页上。
//
// key 不在这一层：它只待在云函数里（见 server/src/protocol.js 的文件头）。
// 这个文件里没有、也不能有任何可用的模型凭证 —— 扩展包是要发给朋友的。
//
// 凭证：**只有注册口令**（服务端地址 + 注册口令就是这条路的"通道"）。同步口令在这条路上
// 既不参与判断、也不是备选 —— 它只管记录上不上云（识别只问一次模型，不上传也不拉取任何记录，
// 所以只想用识别、不想把记录放到服务端的人照样能用）。调用方负责判"通道通不通"，
// 见 popup.js 的 maybeAiSuggest 与 dashboard.js 的 renderAiSection。
import * as S from './shared.js';
import * as SYNC from './sync.js';

export const AI_KEY = 'jobTrackerAi';           // 开关
export const AI_CACHE_KEY = 'jobTrackerAiCache'; // 本机识别缓存
const CACHE_VERSION = 1;
const CACHE_MAX = 300;        // 最多留多少页：够覆盖一整轮秋招，也就几十 KB
const CACHE_TTL = 60 * 24 * 3600 * 1000;  // 60 天（见文件头第 3 点）
const CALL_TIMEOUT_MS = 12000; // 服务端那边还有自己的超时（见 protocol.js 的 aiTimeoutMs）

export const DEFAULT_AI = { enabled: true };

export async function loadAiCfg() {
  const raw = await chrome.storage.local.get(AI_KEY);
  return { ...DEFAULT_AI, ...(raw[AI_KEY] || {}) };
}

export async function saveAiCfg(patch) {
  const next = { ...(await loadAiCfg()), ...patch };
  await chrome.storage.local.set({ [AI_KEY]: next });
  return next;
}

// ---------- 两个确定性键 ----------
export function pageKey(url) {
  try { return S.normalizeUrl(String(url || '').trim()) || ''; } catch { return ''; }
}

// 标题指纹：压空白、去大小写差异、截断。**不改内容** —— 标题是页面的身份，
// 改一个字的"归一化"都可能把两个不同岗位认成同一个
export function titleKey(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
}

// ---------- 本机缓存 ----------
// 读-改-写用一条 promise 链串起来：两个面板同时开着时，后写的那次不能把前一次的整份 map 覆盖掉
let chain = Promise.resolve();
const serialize = (fn) => (chain = chain.then(fn, fn));

async function readCache() {
  const raw = await chrome.storage.local.get(AI_CACHE_KEY);
  const c = raw[AI_CACHE_KEY];
  if (!c || c.v !== CACHE_VERSION || !c.items || typeof c.items !== 'object') return { v: CACHE_VERSION, items: {} };
  return c;
}

function prune(items) {
  const keys = Object.keys(items);
  if (keys.length <= CACHE_MAX) return items;
  // 按时间淘汰最旧的那些（超出上限只可能发生在"存了几百个不同岗位"之后）
  keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0));
  for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete items[k];
  return items;
}

/**
 * 查本机缓存。**标题对不上就当没有** —— 键相同、标题不同 = 同一个链接换了岗位，
 * 拿旧答案会填出一个完全不相干的岗位名（比慢几秒严重得多）。
 * 过期也当没有：这一层是唯一的缓存，没有别处兜"标题没变、内容变了"。
 * @returns {{company:string, position:string}|null}
 */
export async function getCached(url, title) {
  const key = pageKey(url);
  if (!key) return null;
  const c = await readCache();
  const row = c.items[key];
  if (!row || row.t !== titleKey(title)) return null;
  if (!row.c && !row.p) return null;
  if (Date.now() - (row.at || 0) > CACHE_TTL) return null;
  return { company: row.c || '', position: row.p || '' };
}

export async function putCached(url, title, ans) {
  const key = pageKey(url);
  if (!key || (!ans?.company && !ans?.position)) return;
  return serialize(async () => {
    const c = await readCache();
    c.items[key] = { t: titleKey(title), c: ans.company || '', p: ans.position || '', at: Date.now() };
    prune(c.items);
    await chrome.storage.local.set({ [AI_CACHE_KEY]: c });
  });
}

export async function clearCache() {
  const c = await readCache();
  const n = Object.keys(c.items).length;
  await chrome.storage.local.remove(AI_CACHE_KEY);
  return n;
}

export async function cacheCount() {
  return Object.keys((await readCache()).items).length;
}

// ---------- 「答案是不是这一页上的文字」 ----------
// 与 tools/bench-llm.mjs 的 inPage 同一套判据：先去空白/括号/分隔符，再给公司名做一次
// 后缀剥离（页面写「奇瑞」、答案写「奇瑞集团」也算数）。
// 这条判据**只管自动采用**：页面上的字才算数，模型自己造的（哪怕看着很像）一律只做建议 ——
// 用户看到的预填值必须是这一页上真有的东西，否则他根本没法核对。
const aiNorm = (x) => String(x == null ? '' : x).replace(/[\s（）()【】\[\]·\-—]/g, '').toLowerCase();
const aiStripSuffix = (s) => aiNorm(s)
  .replace(/(股份有限公司|有限责任公司|有限公司|集团控股|集团|控股|公司)$/g, '')
  .replace(/(校园招聘|招聘官网|校招官网|招聘|校招|官网)$/g, '');

export function groundedIn(pageText, value) {
  const p = aiNorm(pageText);
  const a = aiNorm(value);
  if (!p || !a) return false;
  if (p.includes(a)) return true;
  const s = aiStripSuffix(value);
  return s.length >= 2 && s !== a && p.includes(s);
}

// 候选串：extract.js 给的是 {value, score}，这里只取文本（去重、截断），
// 与 bench 的 buildPayload 同款 —— 发出去的东西必须和量过的那份一致
export function topCandidates(list, max = 8) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const v = String(item?.value ?? item ?? '').replace(/\s+/g, ' ').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v.slice(0, 200));
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 判据用的页面文本：调用方给了整页文本就用它（popup 手里有 JD，判得最准），
 * 没给就退回「标题 + 链接 + 两组候选串」—— 后者正是发出去的那份输入，
 * 范围小一些，但仍然全是"页面上真有的字"，不会把幻觉放进来。
 */
function groundingText(payload) {
  const given = String(payload?.pageText || '').trim();
  if (given) return given;
  const vals = (list) => (Array.isArray(list) ? list : []).map((x) => String(x?.value ?? x ?? ''));
  return [payload?.title || '', payload?.url || '', ...vals(payload?.positionCandidates), ...vals(payload?.companyCandidates)].join('\n');
}

/**
 * 拿一次建议：先看本机缓存，没有才问服务端（服务端只问模型，不缓存）。
 * 任何失败都返回 null —— 调用方什么都不用做，规则结果还在。
 * @returns {Promise<{company:string, position:string, from:'cache'|'server', grounded:boolean}|null>}
 *          grounded = 答案是不是这一页上真实出现过的字。**只有它为真才允许自动采用**
 */
export async function recognize(payload, cfg) {
  if (!pageKey(payload?.url)) return null;

  const hit = await getCached(payload.url, payload.title);
  if (hit) return { ...hit, from: 'cache', grounded: true };

  let r = null;
  try {
    r = await SYNC.recognizeJob(cfg, {
      u: String(payload.url || '').slice(0, 500),
      ti: String(payload.title || '').slice(0, 300),
      co: topCandidates(payload.companyCandidates),
      po: topCandidates(payload.positionCandidates),
    }, { timeoutMs: CALL_TIMEOUT_MS });
  } catch {
    return null;   // 服务端没配 AI、超时、断网：都是「这次没有建议」，不是错误
  }
  if (!r?.ok || (!r.company && !r.position)) return null;

  const ans = { company: r.company || '', position: r.position || '' };
  // 判据在这里判、也只用这一份实现：服务端只把答案原样带回来（它手里只有候选串，判不如这里准）。
  // 过了才写本机缓存 —— 幻觉不该被缓存放大给"以后的自己"，也不该被自动填进表单
  const page = groundingText(payload);
  const grounded = (!ans.company || groundedIn(page, ans.company))
    && (!ans.position || groundedIn(page, ans.position));
  if (grounded) await putCached(payload.url, payload.title, ans);
  return { ...ans, from: 'server', grounded };
}
