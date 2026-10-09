// model.js — 本机模型：地址 / API Key / 模型名，以及"识别到底走哪条路"的唯一一处判断
//
// 背景：识别这件事原本只有一条路 —— 页面信息发给服务端，由服务端拿它自己的模型 key 去问模型。
// 这个文件加上第二条路：**请求由浏览器直接发给你自己填的接口**（OpenAI 兼容的 /chat/completions），
// 与云端那条路问的是同一套题（提示词、请求体、解析都在 ai-contract.js 里，两边逐字一致）。
//
// 三条规矩，来自用户 2026-10-08 的决定：
//   ① **配了本机模型就只走它**，不会"失败了偷偷改用云端" —— 配错了要能立刻看见，
//      悄悄回退会让人以为一切正常，钱花了、结论还是旧模型给的。
//   ② **Key 只存本机**（chrome.storage.local 的独立键，不进记录、不进云同步、不进导出备份）。
//      它只出现在发往你填的那个地址的 Authorization 头里，别处一概没有。
//   ③ 本机这条路上**没有额度**（花的是你自己的额度，服务端那本账管不着也不该管）。
//
// 通道怎么定：modelReady() 为真（开关开着 + 三项都填了）就是本机模型；否则退回原来那条路
// （服务端地址 + 注册口令），两条都不成立就是"没有可用通道"，界面照旧提示去配。
import * as SY from './sync.js';
import * as AC from './ai-contract.js';

export const MODEL_KEY = 'jobTrackerModel';

// 每台设备各自的配置：换台机器要重新填（Key 不跟着账号走，也不该跟着走）
export const DEFAULT_MODEL = { enabled: false, baseUrl: '', apiKey: '', model: '' };

// 本机模型的超时比云端那条长得多（云端 12/15 秒，那是"服务端到模型"的一段路）。
// 本机/自建端点可能是台笔记本在跑，冷启动第一次请求几十秒是常事；宁可等，也不要
// 让用户看到一次"超时"却不知道对面其实正在算。
const LOCAL_TIMEOUT_MS = 60000;

export async function loadModelCfg() {
  const raw = await chrome.storage.local.get(MODEL_KEY);
  return { ...DEFAULT_MODEL, ...(raw[MODEL_KEY] || {}) };
}

export async function saveModelCfg(patch) {
  const next = { ...(await loadModelCfg()), ...patch };
  await chrome.storage.local.set({ [MODEL_KEY]: next });
  return next;
}

/** 三项齐全且开关开着 —— 只有这一种情况才走本机模型。 */
export function modelReady(cfg = {}) {
  return Boolean(cfg.enabled
    && String(cfg.baseUrl || '').trim()
    && String(cfg.apiKey || '').trim()
    && String(cfg.model || '').trim());
}

/**
 * 缓存指纹：识别结果是在**哪个模型**下问出来的。''=云端那条路（行为没变，老缓存照旧命中）。
 * 换地址或换模型 → 指纹变了 → 老答案不再命中，会重新问一遍。
 * 这条是"配了自己的模型，结论真的跟着变"的保证；反过来说，同一个模型的重复访问照旧走缓存。
 * **只放地址与模型名** —— 这是要写进缓存行的东西，Key 绝不能进来。
 */
export function modelSig(cfg = {}) {
  if (!modelReady(cfg)) return '';
  return `local|${normalizeBaseUrl(cfg.baseUrl)}|${String(cfg.model).trim()}`;
}

/** 接口地址：补 https://、去尾部斜杠；顺手把整条 /chat/completions 也去掉（用户常常整条粘进来）。 */
export function normalizeBaseUrl(url) {
  const base = SY.normalizeEndpoint(url);
  if (!base) return '';
  return base.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

/** 实际会去调的那条地址。界面上把它显示出来 —— "我填的地址被改掉了"要看得见，而不是猜。 */
export function callUrl(url) {
  const base = normalizeBaseUrl(url);
  return base ? `${base}/chat/completions` : '';
}

/**
 * 一眼就知道这条地址不是 OpenAI 兼容路的（Anthropic 的 /anthropic、/v1/messages 那些）。
 * 与其发出去、再拿一个看不懂的回包猜原因，不如在保存/测试的那一下就说清楚。
 * 只做提醒，不拦着保存 —— 地址千奇百怪，真正说话的是「测试连接」的结果。
 */
export function endpointWarning(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/\/anthropic(\/|$)/i.test(raw) || /\/v1\/messages(\/|$)/i.test(raw) || /\/messages$/i.test(raw)) {
    return '这条地址是 Anthropic 协议（/v1/messages）的入口，本功能只发 OpenAI 兼容的 /chat/completions —— 请换成该平台 OpenAI 兼容的那个地址。';
  }
  return '';
}

// ---------- 跨域权限 ----------
// 扩展默认没有访问任何网站的权限（装的时候不会吓人）。只有你填了地址、点了保存/测试，
// 才会向浏览器申请**那一个地址**的访问权 —— 申请是浏览器弹窗、由你点同意，不是暗中拿到的。
export function originPattern(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}/*`;
  } catch { return ''; }
}

/** 要授权的那一处写成人看得懂的样子（https://api.deepseek.com）—— 提示文案里到处要用。 */
export function hostLabel(url) {
  return originPattern(url).replace(/\/\*$/, '');
}

export async function hasHostPermission(url) {
  const origin = originPattern(url);
  if (!origin || !chrome?.permissions?.contains) return false;
  try { return await chrome.permissions.contains({ origins: [origin] }); } catch { return false; }
}

/**
 * 申请该地址的访问权。**必须在用户点击的那一下里调用**（浏览器只认用户手势，
 * 所以调用方要在任何 await 之前先调它，否则弹窗不会出现）。
 */
export async function requestHostPermission(url) {
  const origin = originPattern(url);
  if (!origin || !chrome?.permissions?.request) return false;
  try { return await chrome.permissions.request({ origins: [origin] }); } catch { return false; }
}

// ---------- 识别走哪条路 ----------
/**
 * 这次识别该找谁。三个结果：
 *   local = 配了本机模型（默认就走它）
 *   cloud = 没配本机模型，但服务端地址 + 注册口令都在（原来的那条路）
 *   none  = 两条都不成立（界面据此提示去配，不是错误）
 */
export async function resolveChannel() {
  const cfg = await loadModelCfg();
  if (modelReady(cfg)) return { mode: 'local', cfg, sync: null };
  const sync = await SY.loadSync();
  if (sync.endpoint && sync.enrollKey) return { mode: 'cloud', cfg, sync };
  return { mode: 'none', cfg, sync };
}

// ---------- 发请求 ----------
/**
 * 本机这条路的输出上限（token）。**题面（提示词与输入）与云端逐字相同，只有这一项放宽** ——
 * 用户填的模型很可能是"会思考"的那种（思考过程也吃 token），而云端那套 200/800 是拿
 * **关掉思考**的模型量出来的。照搬过来的后果是：模型想完了、额度也没了，回包里的 content
 * 是个空串（finish_reason=length），用户看到的却是"回的不是能识别的格式" —— 明明接口是好的。
 * 放宽只是"允许它写到这么多"，不多写就不会多花钱。
 */
const LOCAL_BUDGET = { recognize: 2000, classify: 4000 };
const LOCAL_BUDGET_MAX = 8000;      // 证据确凿时（finish_reason=length）再翻一倍，最多到这里
const LOCAL_BUDGET_ATTEMPTS = 2;    // 额度这件事最多试两次，不来回打转

// 端点的脾气：两个可选的"要求"各自只许关一次，关了就记住（下次不再撞同一堵墙）。
//   response_format:{type:'json_object'} —— 少数 OpenAI 兼容端点不认它
//   enable_thinking:false 这类附加参数 —— 别家不认的更多（云端那条路只有一个开关，
//   见 server/src/protocol.js 的 aiJsonMode；它面对的是自家部署时选定的那一个端点，
//   这里面对的是用户自己填的任意端点，所以多留一个）
// 关不关**只看 400 的报错点名了谁**：点了谁摘谁、立刻重问一次；谁也没点就原样报错（不瞎猜）。
// 两个最多各关一次 → 一个通道最多发三次，不会打转。
// **按通道记**（sig 变了就恢复原样）：换地址或换模型等于换了端点，上一家的脾气不算数。
const RE_JSON_MODE = /response_format|json_object|response format/i;
const RE_EXTRA = /enable_thinking|thinking|unknown|unsupported|unrecognized|unexpected|invalid[^.]{0,24}(param|field|arg)|extra[^.]{0,16}field/i;
let taste = { sig: '', jsonMode: true, extra: true };

const fail = (code, error) => ({ ok: false, code, error, local: true });

async function postChat(base, apiKey, body) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), LOCAL_TIMEOUT_MS) : null;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    // 整份回包交给解析（只留一个防病态体积的上限）——
    // 之前这里切了 4000 字再解析：会思考的模型把思考过程也写进回包，一超长就 JSON 解析不了，
    // 报出来的却是"回的不是能识别的格式"（接口明明是好的）。截断只该发生在给人看的那一份上
    return { res, text: (await res.text()).slice(0, 200000) };
  } catch (e) {
    // 到这一步基本只有三种：地址写错/服务没开、网线不通、等太久。权限那件事在前面已经拦过了
    throw new Error(ctl?.signal.aborted
      ? `本机模型 ${LOCAL_TIMEOUT_MS / 1000} 秒内没有回应（模型太大、在冷启动，或地址不对）`
      : '连不上这个地址（检查地址是否写对、服务是否已启动、这台机器能不能访问它）');
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * 走本机模型问一次。返回形状与云端那条路**完全一致**（ok/ms/company/position 或 ok/items），
 * 调用方（ai.js）因此不需要知道自己走的是哪条路。
 * @param {'recognize'|'classify'} kind
 * @param {object} body 与发给服务端的请求体同形（recognize: {u,ti,co,po}；classify: {names,custom?}）
 */
/** 给人看的回包开头（换行压平、截断）—— 报错信息里带上它，用户能直接贴回来。 */
const headOf = (text, n = 160) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n) || '(空回包)';

/**
 * HTTP 200、但没拿到答案时说清**到底是哪一种**。
 * 这句话会原样显示给用户，所以它得能指导下一步（换模型名 / 这个地址不是 OpenAI 兼容的 /
 * 额度被思考吃完了），不能只是一句"格式不对" —— 用户没法拿那句话做任何事。
 * @returns {{reason:string, budgetHit:boolean}} budgetHit=true 表示"额度用完了"，
 *          调用方据此把上限翻一倍再试一次（这是唯一一种"多试一次就能好"的情况）
 */
function shapeError(data, text) {
  if (!data) return { reason: `回包不是 JSON（开头：${headOf(text)}）`, budgetHit: false };
  if (!Array.isArray(data.choices)) {
    const keys = Object.keys(data).join('、') || '无';
    return { reason: `回包里没有 choices —— 这不是 OpenAI 兼容的 /chat/completions 回包（顶层字段：${keys}）`, budgetHit: false };
  }
  const ch = data.choices[0] || {};
  const fin = ch.finish_reason ? `，finish_reason=${ch.finish_reason}` : '';
  if (!data.choices.length) return { reason: `回包里的 choices 是空的：模型这一轮什么都没产出`, budgetHit: false };
  const msg = ch.message || {};
  const budgetHit = ch.finish_reason === 'length';
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
    return {
      reason: `答案全在 reasoning_content（思考过程）里，content 是空的 —— 这个模型默认会思考，换一个不思考的模型名通常就好了`,
      budgetHit,
    };
  }
  if (typeof msg.content === 'string' && !msg.content.trim()) {
    return {
      reason: budgetHit
        ? `模型把输出额度都用完了，content 是空的（finish_reason=length）`
        : `模型回了个空答案（content 是空字符串${fin})`,
      budgetHit,
    };
  }
  if (!('content' in msg)) {
    const keys = Object.keys(msg).join('、') || '无';
    return { reason: `choices[0].message 里没有 content 字段（有的是：${keys}）`, budgetHit };
  }
  return { reason: `回包结构对不上：content 不是字符串`, budgetHit };
}

/**
 * 「模型答了、但没给出答案」时说人话。三种情况必须分开 —— 它们的下一步完全不同：
 *   · 回了空答案（`{"company":"","position":""}`）：模型说这一页上没有，问题多半在**我们给了它什么线索**
 *   · 回的压根不是约定形状：问题在**模型/提示词那一侧**（换个模型名通常就好）
 * 而"给它的线索有多少条"是用户唯一能自己核对的现场记录（页面上抓到了什么只有他看得见）——
 * 一条候选都没有时，把最可能的原因（页面没读到）与去哪确认（JD 那行）一并写上，
 * 否则他会一直在模型和配置上找原因，而问题其实在页面。
 */
function emptyAnswerText(content, lead, tail = '') {
  const raw = `它回的是：${headOf(content, 80)}`;
  if (!/\{[\s\S]*\}/.test(AC.stripThinking(content))) return `模型没按约定格式回答（${raw}）`;
  return `${lead}（${raw}）${tail}`;
}

/** 岗位识别答了空：把"这次问它的线索"写进报错里 */
function emptyRecognizeText(content, p) {
  const co = p.companyCandidates.length;
  const po = p.positionCandidates.length;
  if (!co && !po) {
    return emptyAnswerText(content,
      '模型答了空：这一页一条候选都没抓到，它没有可挑的线索',
      '。多半是页面内容没读到 —— 内容在 iframe 里、需要登录、或还没加载完；看上面「岗位 JD」那行是不是也写着"未抓到"');
  }
  return emptyAnswerText(content,
    `模型答了空：它说这一页上没有它认得出的公司名/岗位名。这次给它的线索：公司候选 ${co} 条、岗位候选 ${po} 条`);
}

/** 企业类型答了空：同一件事（它答了，只是没给出值），把这一批有几家写进去 */
function emptyClassifyText(content, p) {
  return emptyAnswerText(content, `模型没能认出这一批里的任何一家（这一批 ${p.names.length} 家）`);
}

export async function callLocal(kind, body, cfgArg = null) {
  const cfg = cfgArg || (await loadModelCfg());
  if (!modelReady(cfg)) return fail('LOCAL_OFF', '还没有配置本机模型');

  const base = normalizeBaseUrl(cfg.baseUrl);
  const p = kind === 'recognize' ? AC.sanitizeAiPayload(body) : AC.sanitizeClassifyPayload(body);
  if (!p) return fail('LOCAL_INPUT', '这次的输入是空的，没什么可识别的');

  if (!(await hasHostPermission(base))) {
    return fail('LOCAL_PERM', `还没有允许扩展访问 ${hostLabel(base)}：在设置里重新保存一次本机模型配置，浏览器会弹出授权提示`);
  }

  const sig = modelSig(cfg);
  if (taste.sig !== sig) taste = { sig, jsonMode: true, extra: true };

  const t0 = Date.now();
  let budget = LOCAL_BUDGET[kind] || 800;
  let budgetTries = 0;
  // 两条退让阶梯共用这一个循环，各自都有上限（脾气：两个参数各摘一次；额度：最多翻一倍一次），
  // 加上 4 次硬上限，任何组合都不会打转
  for (let attempt = 0; attempt < 4; attempt++) {
    const build = kind === 'recognize' ? AC.buildAiRequest : AC.buildClassifyRequest;
    const reqBody = build(p, String(cfg.model).trim(), taste.extra ? AC.AI_DEFAULT_EXTRA : null, { jsonMode: taste.jsonMode });
    // 题面按契约原样，只有输出上限按本机放宽（见 LOCAL_BUDGET 的注释）
    reqBody.max_tokens = budget;

    let res, text;
    try { ({ res, text } = await postChat(base, String(cfg.apiKey).trim(), reqBody)); }
    catch (e) { return fail('LOCAL_NET', e.message); }

    const snippet = headOf(text, 200);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return fail('LOCAL_AUTH', `接口拒绝了这次请求（HTTP ${res.status}）：检查 API Key 是否填对、这个 Key 有没有该模型的权限`);
      }
      // 400 且报错点名了某个可选参数 → 摘掉它重问一次（这也正是"这家端点不认它"的证据）。
      // 两个各只摘一次，所以最多重问两回；报错没点名就原样报出去，不瞎猜
      if (res.status === 400) {
        if (taste.jsonMode && RE_JSON_MODE.test(snippet)) { taste.jsonMode = false; continue; }
        if (taste.extra && RE_EXTRA.test(snippet)) { taste.extra = false; continue; }
      }
      return fail('LOCAL_HTTP', `接口返回 HTTP ${res.status}${snippet ? '：' + snippet : ''}`);
    }

    let data = null;
    try { data = JSON.parse(text); } catch { /* 不是 JSON：下面按"没拿到答案"处理 */ }
    const content = data?.choices?.[0]?.message?.content;
    const good = typeof content === 'string' && content.trim();
    const ms = Date.now() - t0;

    if (good) {
      if (kind === 'recognize') {
        const ans = AC.parseAiAnswer(content);
        if (ans && (ans.company || ans.position)) return { ok: true, company: ans.company, position: ans.position, ms };
        // 答案没解析出来：如果是"额度用完了"，值得把上限翻一倍再问一次（截断的 JSON 解析不出来）
        if (data?.choices?.[0]?.finish_reason === 'length' && budgetTries < LOCAL_BUDGET_ATTEMPTS - 1 && budget < LOCAL_BUDGET_MAX) {
          budgetTries++; budget *= 2; continue;
        }
        // 答了、但没给出答案：把它的原话带出去 —— 「AI 没生效」与「模型答了没对上」
        // 是两件事，只报前一句会让用户永远查不到后一句（详见 emptyAnswerText）
        return fail('AI_EMPTY', emptyRecognizeText(content, p));
      }
      const items = AC.parseClassifyAnswer(content, p.names, p.custom);
      if (items.length) return { ok: true, items, ms };
      if (data?.choices?.[0]?.finish_reason === 'length' && budgetTries < LOCAL_BUDGET_ATTEMPTS - 1 && budget < LOCAL_BUDGET_MAX) {
        budgetTries++; budget *= 2; continue;
      }
      // 与云函数同款的一行日志（那边见 protocol.js 的 handleClassify）：不然后面只能看到
      // "什么都没发生"，分不清是模型没答、答的写法对不上候选集、还是请求根本没到
      console.log(`[本机模型] ${ms}ms 没有可用答案（${p.names.length} 家）｜模型原始回包：${headOf(content, 200)}`);
      return fail('AI_EMPTY', emptyClassifyText(content, p));
    }

    // 200 但拿不到内容：说清是哪一种。**唯一值得重试的是"额度被用完了"** ——
    // 证据（finish_reason=length）明明白白，翻一倍再来一次通常就好了；
    // 别的形状重试一万次也一样，原样报出去让人去改配置（换模型名 / 换地址）
    const { reason, budgetHit } = shapeError(data, text);
    if (budgetHit && budgetTries < LOCAL_BUDGET_ATTEMPTS - 1 && budget < LOCAL_BUDGET_MAX) {
      budgetTries++; budget *= 2; continue;
    }
    console.log(`[本机模型] ${ms}ms 没拿到答案：${reason}｜原始回包：${headOf(text, 400)}`);
    return fail('LOCAL_FORMAT', `接口通了，但没拿到能用的答案：${reason}`);
  }
  return fail('LOCAL_FORMAT', '试了几轮都没拿到能用的答案（对方端点反复给出无法使用的回包）');
}

/**
 * 「测试连接」：拿一家编出来的公司走一遍完整流程（含解析），所以它验证的是**整条路**，
 * 不是"服务器活着吗"。三种结局都算通：真的给出了值、给出了值但写法没对上、模型答了空 ——
 * 都证明"请求发得出去、回包收得回来"。只有连不上/被拒/格式不对才是没通。
 */
export async function testLocal(cfg) {
  const t0 = Date.now();
  const r = await callLocal('classify', { names: ['测试科技有限公司'] }, cfg);
  const ms = Date.now() - t0;
  if (r.ok) return { ok: true, ms, note: `模型回了 ${r.items.length} 家（这家是编的，答什么不重要）` };
  if (r.code === 'AI_EMPTY') return { ok: true, ms, note: '接口通了（这家公司是编的，模型没给值属于正常）' };
  return { ok: false, ms, code: r.code, error: r.error };
}
