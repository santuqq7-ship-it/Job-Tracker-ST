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
// 识别有两个可能的去处，由 model.js 的 resolveChannel() 一处决定：
//   · 配了本机模型 → 浏览器**直接**问你填的那个接口（本地模型接入，见 model.js）
//   · 没配 → 老路：服务端地址 + 注册口令，由云函数拿它自己的 key 去问（server/src/protocol.js）
// 两条路问的是**同一套题**：提示词、请求体、回包解析都在 ai-contract.js 里，
// 与 server/src/core.js 的那一份逐字一致（由 tools/test-ai.mjs 断言）。
//
// 这个文件里没有、也不能有任何**写死的**模型凭证 —— 扩展包是要发给朋友的。
// 本机模型那个 Key 是用户自己填的、只存在他自己那台机器上（不进记录、不进同步、不进备份，
// 见 model.js 的文件头）；包里没有，备份里也没有。
//
// 凭证（云端那条路）：**只有注册口令**（服务端地址 + 注册口令就是它的"通道"）。同步口令在这条路上
// 既不参与判断、也不是备选 —— 它只管记录上不上云（识别只问一次模型，不上传也不拉取任何记录，
// 所以只想用识别、不想把记录放到服务端的人照样能用）。调用方负责判"通道通不通"，
// 见 popup.js 的 maybeAiSuggest 与 dashboard.js 的 renderAiSection。
//
// 失败怎么表现，两条路**故意不一样**：本机模型是用户自己配的，配错了要立刻看得见（把原因说出来，
// 且绝不偷偷改用云端）；云端那条路照旧安静降级（"这次没有建议"不是错误，用户什么都没配错）。
import * as S from './shared.js';
import * as SYNC from './sync.js';
import * as CT from './company-type.js';
import * as MODELS from './model.js';

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
 *
 * `mk` 是问出这个答案的**通道指纹**（model.js 的 modelSig）：'' = 云端那条路。
 * 用户配了本机模型（或换了模型）之后，云端那份答案就不再是他要的了，按新通道重问一遍 ——
 * 这正是"配了自己的模型，结论真的跟着变"。老缓存行没有 `mk`，读作空串，
 * 没配本机模型的人指纹也是空串，照旧命中，两边都零影响。
 * @returns {{company:string, position:string}|null}
 */
export async function getCached(url, title, mk = '') {
  const key = pageKey(url);
  if (!key) return null;
  const c = await readCache();
  const row = c.items[key];
  if (!row || row.t !== titleKey(title)) return null;
  if (!row.c && !row.p) return null;
  if (Date.now() - (row.at || 0) > CACHE_TTL) return null;
  if ((row.mk || '') !== (mk || '')) return null;
  return { company: row.c || '', position: row.p || '' };
}

export async function putCached(url, title, ans, mk = '') {
  const key = pageKey(url);
  if (!key || (!ans?.company && !ans?.position)) return;
  return serialize(async () => {
    const c = await readCache();
    c.items[key] = { t: titleKey(title), c: ans.company || '', p: ans.position || '', at: Date.now(), mk };
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
 * 拿一次建议：先看本机缓存，没有才去问（配了本机模型就问它，否则问服务端；服务端只问模型，不缓存）。
 * 云端那条路的任何失败都返回 null —— 调用方什么都不用做，规则结果还在。
 * 本机那条路的失败**带原因返回**（`{failed:{...}}`）：那是用户自己刚配的东西，配错了要立刻看得见，
 * 而且必须让他知道"这次没有回退到云端"，否则他只会以为配了没用。
 * @returns {Promise<{company:string, position:string, from:'cache'|'server'|'local', grounded:boolean}
 *   | {failed:{code:string,error:string,local:boolean}} | null>}
 *          grounded = 答案是不是这一页上真实出现过的字。**只有它为真才允许自动采用**
 */
export async function recognize(payload, cfg) {
  if (!pageKey(payload?.url)) return null;

  const mcfg = await MODELS.loadModelCfg();
  const mk = MODELS.modelSig(mcfg);   // '' = 云端那条路；非空 = 本机模型（也是缓存的通道指纹）
  const hit = await getCached(payload.url, payload.title, mk);
  if (hit) return { ...hit, from: 'cache', grounded: true };

  const body = {
    u: String(payload.url || '').slice(0, 500),
    ti: String(payload.title || '').slice(0, 300),
    co: topCandidates(payload.companyCandidates),
    po: topCandidates(payload.positionCandidates),
  };

  let r = null;
  let from = 'server';
  if (mk) {
    r = await MODELS.callLocal('recognize', body, mcfg);
    if (!r.ok) return { failed: r };
    from = 'local';
  } else {
    try {
      r = await SYNC.recognizeJob(cfg, body, { timeoutMs: CALL_TIMEOUT_MS });
    } catch {
      return null;   // 服务端没配 AI、超时、断网：都是「这次没有建议」，不是错误
    }
    if (!r?.ok || (!r.company && !r.position)) return null;
  }

  const ans = { company: r.company || '', position: r.position || '' };
  // 判据在这里判、也只用这一份实现：服务端只把答案原样带回来（它手里只有候选串，判不如这里准）。
  // 过了才写本机缓存 —— 幻觉不该被缓存放大给"以后的自己"，也不该被自动填进表单
  const page = groundingText(payload);
  const grounded = (!ans.company || groundedIn(page, ans.company))
    && (!ans.position || groundedIn(page, ans.position));
  if (grounded) await putCached(payload.url, payload.title, ans, mk);
  return { ...ans, from, grounded };
}

// ===========================================================================
// 企业类型识别（客户端一半）
//
// 与岗位识别共用同一套"凭证只有注册口令"的通道，但缓存**分开放**：
//   · 岗位缓存按「页面链接 + 标题指纹」—— 判据是"答案在不在这一页上"
//   · 企业类型缓存按**公司名**—— 同一家公司投了 3 个岗位只该问一次模型；
//     而且它跟"哪一页"无关：换个招聘网站投同一家公司，答案是一样的
// 两条判断的对象根本不同，塞进同一个 map 只会互相干扰，所以各存各的。
//
// 公司名之外，企业类型缓存还挂一个**候选集指纹**（cs，见 company-type.js 的 customSig）：
// 答案是"在某一份候选集下"给出的，用户后来加了更贴切的写法就得按新清单重问一次。
//
// 本地映射库与关键词规则（company-type.js）在调用方先跑：**能本地定的绝不上云**。
// 这个函数只负责"本地认不出来的那些公司"。
// ===========================================================================

export const AI_TYPE_CACHE_KEY = 'jobTrackerAiTypes';
const TYPE_CACHE_VERSION = 1;
const TYPE_CACHE_MAX = 300;
const TYPE_CACHE_TTL = 60 * 24 * 3600 * 1000;   // 60 天，与岗位缓存同款
const TYPE_BATCH = 12;                          // 与服务端 sanitizeClassifyPayload 的上限一致
const TYPE_CALL_TIMEOUT_MS = 15000;             // 一家公司一批，比单页识别宽松一点

// 缓存键：只做轻度归一（去括号注释、去"有限公司/股份"这类法人后缀）。
// **不剥地名**：「北京燃气」和「上海燃气」剥完都是「燃气」，那会把两家公司并成一条。
// 够用的原因：能进到这个函数的公司，本地库与规则都已经认不出来了，
// 同一家公司在记录里出现的写法通常就是同一个（多条投递的重复由它来省）。
export function typeKey(name) {
  return CT.normCompanyName(String(name || ''));
}

async function readTypeCache() {
  const raw = await chrome.storage.local.get(AI_TYPE_CACHE_KEY);
  const c = raw[AI_TYPE_CACHE_KEY];
  if (!c || c.v !== TYPE_CACHE_VERSION || !c.items || typeof c.items !== 'object') {
    return { v: TYPE_CACHE_VERSION, items: {} };
  }
  return c;
}

function pruneTypes(items) {
  const keys = Object.keys(items);
  if (keys.length <= TYPE_CACHE_MAX) return items;
  keys.sort((a, b) => (items[a].at || 0) - (items[b].at || 0));
  for (const k of keys.slice(0, keys.length - TYPE_CACHE_MAX)) delete items[k];
  return items;
}

/**
 * 查某家公司认过的结果。
 *
 * `cs` 是那次询问时的候选集指纹（company-type.js 的 customSig）。要对指纹的原因：
 * 用户加了个更贴切的写法（「银行」），上一轮按旧候选集给的「金融」就不再是他要的答案，
 * 得按新清单重问一次 —— 这就是"自定义值真正生效"。
 * 老缓存行没有 `cs`，读作空串；没有自定义值的用户指纹也是空串，照旧命中，两边都零影响。
 * `mk` 同理：问出这个答案的通道指纹（model.js 的 modelSig，'' = 云端那条路）。
 * 用户配了本机模型、或换了个模型，上一份答案就不再是他要的，按新通道重问一遍。
 * 两个指纹不符都只是**这次不命中**，不删这一行：下次问完写缓存时自然用新指纹覆盖它。
 * @returns {{nature:string, industry:string}|null} 缓存里没有、过期、指纹不符、或两项都空 → null
 */
export async function getCachedType(name, cs = '', mk = '') {
  const key = typeKey(name);
  if (!key) return null;
  const c = await readTypeCache();
  const row = c.items[key];
  if (!row || (!row.n && !row.i)) return null;
  if (Date.now() - (row.at || 0) > TYPE_CACHE_TTL) return null;
  if ((row.cs || '') !== (cs || '')) return null;
  if ((row.mk || '') !== (mk || '')) return null;
  return { nature: row.n || '', industry: row.i || '' };
}

export async function clearTypeCache() {
  const c = await readTypeCache();
  const n = Object.keys(c.items).length;
  await chrome.storage.local.remove(AI_TYPE_CACHE_KEY);
  return n;
}

export async function typeCacheCount() {
  return Object.keys((await readTypeCache()).items).length;
}

/**
 * 识别失败时说给用户的那句话：每一句对应一个 code（服务端或传输层带回来的）。
 * 主面板与小面板**共用这一份**，别各写一份 —— 小面板曾长期停在"这次没拿到结果（模型没认出这家，
 * 或服务端没配模型 key / 到今日上限）"那句把四种原因糊在一起的老话上：用户既分不清是不是自己没配，
 * 也看不到模型到底答了什么（2026-10-08 用户实测反馈）。
 */
export const AI_FAIL_TEXT = {
  AI_OFF: '服务端没有配模型 key（部署时填 AI_KEY 或环境变量 JOBTRACKER_AI_KEY）',
  AI_LIMIT: '这个注册口令今天的识别次数用完了（明天恢复，已经认过的会走本机缓存）',
  AI_FAIL: '模型这一侧出错了（稍后再点一次试试）',
  ENROLL: '注册口令不对（设置 → ☁ 云同步 里的「注册口令」）',
  NET: '请求没送出去（服务端地址、网络，或服务端版本太旧没有这个接口）',
  AI_EMPTY: '模型这次的回答是空的 —— 它认不出这家',
  // 本机模型那条路的失败：真实原因在结果的 error 里（哪一步没通、HTTP 几），
  // 这几句只是"只剩一个码"时的兜底（见 failText）
  LOCAL_OFF: '本机模型还没配置（设置 → 🤖 识别模型）',
  LOCAL_INPUT: '这次的输入是空的，没什么可识别的',
  LOCAL_PERM: '还没允许扩展访问你填的那个地址（设置 → 🤖 识别模型 里重新保存一次）',
  LOCAL_NET: '连不上你填的地址（检查地址、服务是否已启动）',
  LOCAL_AUTH: '接口拒绝了这次请求（检查 API Key 与模型权限）',
  LOCAL_HTTP: '接口返回了错误（设置 → 🤖 识别模型 里点「测试连接」看具体原因）',
  LOCAL_FORMAT: '接口通了，但回的不是能识别的格式（需要 OpenAI 兼容的 /chat/completions）',
};

/**
 * 失败原因给人看的那句话。
 * 本机模型的失败**用它自己带回来的那句**（"HTTP 401：检查 API Key"这种），
 * 云端那条路仍走上面的静态表 —— 服务端返回的 error 是写给部署者看的（提到环境变量、云函数），
 * 对普通用户不友好，那是刻意的分工。
 */
export function failText(r) {
  if (!r) return '';   // 没有失败对象（比如这一步压根没被调到）→ 调用方自己决定兜底那句
  const code = String(r.code || '');
  if (r.local && r.error) return String(r.error);
  return AI_FAIL_TEXT[code] || AI_FAIL_TEXT.AI_FAIL;
}

/**
 * 「模型说了话、但写法没落在候选集里」时，把它说的原话拼成一句给人看的片段。
 * 值来自模型，**先转义再进 innerHTML**（两个面板的提示区都是 innerHTML）。
 * @param {{nature?:string, industry?:string}} [said]
 */
export function saidText(said) {
  const parts = [];
  if (said?.nature) parts.push(`性质「${S.escapeHtml(said.nature)}」`);
  if (said?.industry) parts.push(`行业「${S.escapeHtml(said.industry)}」`);
  return parts.join('、');
}

/**
 * 批量识别企业类型。只负责"本地认不出来的公司"，其余全在调用方。
 *
 * 三件事按顺序做：查本机缓存 → 没命中的去重、分批（≤12）问服务端 → 逐条按**本次候选集**校验后写缓存。
 * （传 `force` 就跳过第一步：用户手动按的「再认一次」要的是新答案，不是缓存里那份。）
 * **任何失败都只是"这批没结果"**：返回已拿到的部分 + failed 名单（调用方可以重试），不抛异常 ——
 * 调用它的地方（导入预览、主面板弹窗）都在等一个锦上添花的结果，不能把界面搞成报错页。
 * @param {string[]} names 公司名（原样，允许重复与空值）
 * @param {object} cfg 服务端配置（endpoint + enrollKey）；配了本机模型时用不到它
 * @param {{onProgress?: (p:{done:number,total:number,from:string})=>void, force?: boolean}} opts
 *   `force` = 用户自己按了「AI 再认一次」：跳过缓存直接问一遍。缓存**照写**（这次的答案就是
 *   以后查到的那个，`at` 一并刷新）。用途是"本机企业库/规则给错了"这种场景 —— 那时缓存里
 *   要么没有这家、要么存的正是那个被用户否掉的答案，读缓存等于按钮点了没反应。
 * @returns {Promise<{results:{name:string,nature:string,industry:string,said?:{nature?:string,industry?:string},from:'cache'|'ai'}[],
 *   failed:string[], calls:number, code:string, fail:object|null, rejected:{name:string,said:{nature?:string,industry?:string}}[]}>}
 *   `code` = 最后一次失败的原因（'AI_OFF' 没配 key / 'AI_LIMIT' 到额度 / 'AI_EMPTY' 模型没答 /
 *   'AI_FAIL' 模型侧出错 / 'ENROLL' 注册口令不对 / 'NET' 请求没送出去 / 'LOCAL_*' 本机模型那条路），
 *   成功时是空串；`fail` 是同一个原因的完整对象（本机模型的失败带着"到底哪一步没通"，
 *   界面用 AI.failText(fail) 取那句话）。
 *   `rejected` = 模型答了但没被采用的那些家（含它的原话），**只用于向用户解释**，不是结果。
 *   后两者都只给"用户自己按的按钮"看：自动那一路照旧安静降级，不看也不显示。
 */
export async function classifyCompanies(names, cfg, { onProgress, force = false } = {}) {
  const out = [];
  const failed = [];
  const seen = new Set();
  const pending = [];
  // 候选集**每次现读本机那份**（枚举 ∪ 用户的自定义值），不在这里缓存 —— 主面板里刚加的
  // 写法，小窗口下一次识别就得算数，这正是"新增的自定义值真正生效"的关键一环。
  // 读不到库（清理中/存储异常）就退回纯枚举：识别是锦上添花，不能因此整个挂掉。
  let custom = null;
  let cs = '';
  try {
    const data = await S.loadData();
    custom = CT.customPayload(data);
    cs = CT.customSig(data);
  } catch {
    custom = null;
    cs = '';
  }
  // 走哪条路同样现读：'' = 云端，非空 = 本机模型（同时也是缓存的通道指纹，
  // 用户配了自己的模型之后，云端那份答案不再命中，会按新通道重问一遍）
  const mcfg = await MODELS.loadModelCfg();
  const mk = MODELS.modelSig(mcfg);
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = typeKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const hit = force ? null : await getCachedType(name, cs, mk);
    if (hit) out.push({ name, ...hit, from: 'cache' });
    else pending.push(name);
  }
  let calls = 0;
  let code = '';           // 最后一次失败的原因码（AI_OFF / AI_LIMIT / AI_EMPTY / AI_FAIL / ENROLL / NET / LOCAL_*）
  let fail = null;         // 同一个原因的完整对象（本机模型的失败带着具体原因，界面据此说得更准）
  const rejected = [];     // 模型答了、但说的值没被采用的那些家（界面据此解释"AI 到底答了什么"）
  if (!pending.length) {
    onProgress?.({ done: out.length, total: out.length, from: 'cache' });
    return { results: out, failed, calls, code, fail, rejected };
  }
  if (onProgress) onProgress({ done: out.length, total: out.length + pending.length, from: 'start' });

  const fresh = [];
  for (let i = 0; i < pending.length; i += TYPE_BATCH) {
    const batch = pending.slice(i, i + TYPE_BATCH);
    calls++;
    let r = null;
    try {
      const req = custom ? { names: batch, custom } : { names: batch };   // 空清单逐字节与今天一致
      r = mk ? await MODELS.callLocal('classify', req, mcfg)
             : await SYNC.classifyCompanies(cfg, req, { timeoutMs: TYPE_CALL_TIMEOUT_MS });
      // "为什么没有答案"写在 code 里（没配 key / 到额度 / 模型没答 / 本机模型没调通），
      // 自动那一路不看它（安静降级），用户自己按的「再认一次」要能说清是哪一种
      if (r && r.ok === false) { code = String(r.code || ''); fail = r; }
    } catch (e) {
      // 没配模型 / 超时 / 断网 / 老服务端没这个路由：这批算失败，界面照常用本地结果
      code = e?.code ? String(e.code) : 'NET';
      fail = null;
      r = null;
    }
    const got = new Map();
    for (const it of Array.isArray(r?.items) ? r.items : []) {
      // 服务端已经按本次候选集过滤过一遍了，这里再校验一次：客户端不该把"线上返回的"当成可信输入。
      // 校验用的必须是**发出去的那一份 custom**（本次开始时的快照），不是重新读一遍 ——
      // 中间用户改了清单的话，回来的答案对应的是旧候选集，拿新清单去卡会把它误判成脏值。
      const nature = CT.isAllowedType('nature', it?.nature, custom) ? it.nature : '';
      const industry = CT.isAllowedType('industry', it?.industry, custom) ? it.industry : '';
      if (!it?.name) continue;
      // 模型对某一栏说了话、却没被采用（写法对不上候选集）：把原话带出去。
      // 它**只用来解释**"AI 答了什么"，不进记录、不进缓存 —— 展示前一律过 escapeHtml
      const said = {};
      if (!nature && it.said?.nature) said.nature = String(it.said.nature).slice(0, 40);
      if (!industry && it.said?.industry) said.industry = String(it.said.industry).slice(0, 40);
      if (!nature && !industry) {
        if (said.nature || said.industry) rejected.push({ name: it.name, said });
        continue;
      }
      got.set(typeKey(it.name), { nature, industry, ...(said.nature || said.industry ? { said } : {}) });
    }
    for (const name of batch) {
      const hit = got.get(typeKey(name));
      if (hit) fresh.push({ name, ...hit, from: 'ai' });
      else failed.push(name);
    }
    onProgress?.({ done: out.length + fresh.length, total: out.length + pending.length, from: 'ai' });
  }
  if (fresh.length) {
    await serialize(async () => {
      const c = await readTypeCache();
      const at = Date.now();
      // cs 与 mk 一并写进去：记下"这个答案是在哪份候选集、哪个模型下给出的"，
      // 清单换了或模型换了才认得出该重问（见 getCachedType）
      for (const x of fresh) c.items[typeKey(x.name)] = { n: x.nature, i: x.industry, at, cs, mk };
      pruneTypes(c.items);
      await chrome.storage.local.set({ [AI_TYPE_CACHE_KEY]: c });
    });
  }
  return { results: [...out, ...fresh], failed, calls, code, fail, rejected };
}
