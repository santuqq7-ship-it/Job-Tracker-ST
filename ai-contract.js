// ai-contract.js — 识别这件事的「题面」：提示词、请求体、回包解析（客户端一半）
//
// 为什么客户端也要有一份：本机模型配好之后，识别请求由**浏览器直接**发给你自己填的接口，
// 中间没有服务端了 —— 而「问什么、怎么判答案」必须与云端那条路**逐字一致**，否则同一家公司
// 在两条路上会得到不同的结果，用户没法解释「为什么换个模型结论就变了」。
// 这个文件就是"同一套"在客户端的那一半。
//
// 它与 server/src/core.js 的 AI 段落是同一套规则的副本：提示词一个字不差、请求体逐字段相同、
// 解析的两条硬规则（回显校验 + 候选集白名单）同款。**两边一致由 tools/test-ai.mjs 的
// 「契约一致性」一组断言盯着** —— 改了任何一边没改另一边，那一组立刻红。
// 为什么不直接从 core.js import 进来：云函数那份源码要跟着扩展发给朋友，而它是服务端的一半
// （同步、鉴权、ICS 都在旁边），只为了让客户端拿到提示词就把整份服务端源码塞进扩展包，不划算。
//
// **改提示词之前先读 server/src/core.js 里那段注释**（每一句都是量出来的，有踩过的坑），
// 改完两边一起改，再跑 `node tools/test-ai.mjs` 与 `node tools/bench-llm.mjs` 看数字有没有退。
//
// 这个文件里没有凭证、不碰 chrome API、不 import 任何东西 —— 只有纯字符串与纯函数。

// ---------- 岗位识别（/api/recognize） ----------

export const AI_PROMPT = `你是招聘网页的信息抽取器。用户会给你一个岗位详情页的网址、网页标题，以及从页面上抓下来的两组候选文本（公司候选、岗位候选）。
你要填的是两个字段：
· company = 招人的这家单位，用大家平时叫的名字（例：拼多多集团、小红书、奇瑞）
· position = 这条招聘信息招的**那一个职位**的完整名称（例：商务管培生（香港）、AI研究算法工程师-智能语音方向）

规则：
1. 优先从候选里挑原串，一个字都不要改写、拼接、翻译或补全；候选里确实没有合适的，才按页面上常见的写法补一个。
2. 公司名用招聘方常用的叫法（例：奇瑞 / 奇瑞集团 都行，小红书 优于 行吟信息科技（上海）有限公司）。不要刻意补全成工商全称，也不要照抄带"招聘/校园招聘"的站点名。
3. 岗位名要完整保留方向、批次、项目、地点等修饰（例：AI研究算法工程师-智能语音方向），不许截断成公共前缀（例：AI研究算法工程师）。
4. 两个答案都必须是**页面上真实出现过的文字**，不许自己造词、改写或翻译；宁可给一个朴素的原串。
5. 下面这些**都不是岗位名**，哪怕它们出现在候选里、哪怕在页面上很显眼：
   · 导航栏与栏目名：校园招聘、社会招聘、实习生招聘、校招公告、职位列表、招聘流程、关于我们、联系我们
   · 按钮文案：立即投递、申请职位、收藏、分享、查看更多、登录/注册
   · 状态与营销标签：热招、急招、已结束、NEW、内推
   · 地点/批次/薪资标签：中国香港、2027届、15-25K
   · 站点名：BOSS直聘、牛客网、智联招聘、前程无忧
   岗位名是"招什么职位"，通常含工程师、经理、管培生、分析师、设计师、专员这类职务词。
6. 只有当岗位候选里**每一条**都属于第 5 类（导航词/按钮/标签/站点名）时，position 才给空串 ""；只要有一条像岗位名的，就必须给出那一条（哪怕它不够完整）—— 空串等于"你帮不上忙"，客户端会退回它自己的预填值。公司确实认不出来时同理给空串 ""。
7. 公司候选为空是常事：从标题里找 —— 标题常以公司名开头（「拼多多集团-PDD校园招聘官网」→ 拼多多集团）；或从网址里的租户名推断（job.xiaohongshu.com → 小红书、careers.pddglobalhr.com → 拼多多）。
8. 拿不准时选页面上最显眼的那条原串，不要编造。

示例 1：
输入：网址 https://job.example.com/campus/detail?jobAdId=1，标题「示例科技招聘」，公司候选 ["示例科技","示例科技（北京）有限公司","加入我们"]，岗位候选 ["后端开发工程师","后端开发工程师（Java方向，2026届秋招）","职位详情"]
输出：{"company":"示例科技","position":"后端开发工程师（Java方向，2026届秋招）"}

示例 2（候选里混着导航词、公司候选为空）：
输入：网址 https://careers.pddglobalhr.com/campus/grad/detail?positionId=1，标题「拼多多集团-PDD校园招聘官网」，公司候选 []，岗位候选 ["实习生招聘","商务管培生（香港）"]
输出：{"company":"拼多多集团","position":"商务管培生（香港）"}

只输出 JSON，不要解释：{"company":"...","position":"..."}`;

// 关掉「深度思考」：这个任务只是从候选里挑一条原样抄出来，不需要思考链（量过上线的速度差）。
// 参数名各家不同（有的叫 thinking / reasoning_effort），所以做成可覆盖的附加参数。
// 有些端点不认这个参数（400），本机这条路会按 model.js 的退化阶梯自动去掉它再试一次。
export const AI_DEFAULT_EXTRA = { enable_thinking: false };

// 发出去的两组候选各留几条（去重后）。8 条是量出来的取值，候选越多 token 越多、准确率并不会更好
const AI_MAX_CANDIDATES = 8;
const AI_MAX_CANDIDATE_LEN = 200;

// 规范化（判「答案是不是发出去过的串」用）：去空白/括号/分隔符 + 小写
const aiNorm = (x) => String(x == null ? '' : x).replace(/[\s（）()【】\[\]·\-—]/g, '').toLowerCase();

// 页面文本里的候选串可能夹带换行 —— 换行会**破坏用户消息的结构**（那是一行一个字段的文本格式），
// 让页面上的文字有机会伪装成字段名。控制字符一律压成空格，长度也截断
const aiClean = (s, max = AI_MAX_CANDIDATE_LEN) =>
  String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const aiTopList = (v) => {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(v) ? v : []) {
    const s = aiClean(item);
    if (!s) continue;
    const k = aiNorm(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= AI_MAX_CANDIDATES) break;
  }
  return out;
};

/**
 * 把识别请求收敛成规范形状。**只做收敛，不做判对错**：拿不准的一律截断而不是拒绝。
 * @returns {{url:string,title:string,companyCandidates:string[],positionCandidates:string[]}|null}
 *          url 为空时返回 null
 */
export function sanitizeAiPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const url = aiClean(body.u, 500);
  if (!url) return null;
  return {
    url,
    title: aiClean(body.ti, 300),
    companyCandidates: aiTopList(body.co),
    positionCandidates: aiTopList(body.po),
  };
}

// 思考内容有两处来源，**两处都不能进答案**：
//   · message.reasoning_content —— 官方 API（DeepSeek、Qwen 那些）把思考单独放这一格，我们压根不读它
//   · content 里内联的思考块（用 think/thinking/reasoning 这类标签包着）—— 中转平台和套了模板的开源模型常常是这种，得自己剥
// 剥的理由不只是"看着干净"：提示词里带着一个示例输出 `{"company":"示例科技",…}`，
// 模型一边想一边把题面抄一遍是常事，**先撞上那个示例**就会把「示例科技」当成这一页的答案。
// 闭合的整段删掉；只有开标签没有闭合的（正想到一半就被额度截断）从那里一路删到末尾 ——
// 那种情况下本来也不存在"最终答案"。大写的 THINKING 一并认（正则带 i）。
const RE_THINK_BLOCK = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// 另一种写法：DeepSeek 系模板把思考夹在 <｜begin▁of▁thinking｜>…<｜end▁of▁thinking｜> 之间
// （两个特殊 token，竖线是全角 ｜）。自建端点或中转平台直接透传模板输出时就会看到它
const RE_THINK_TOKEN = /<｜begin▁of▁thinking｜>[\s\S]*?<｜end▁of▁thinking｜>/g;
const RE_THINK_OPEN = /<(think|thinking|reasoning)\b[^>]*>[\s\S]*$|<｜begin▁of▁thinking｜>[\s\S]*$/i;

/** 剥掉 content 里内联的思考块。**只用于解析** —— 报错时给用户看的回包原文照旧不加工。 */
export function stripThinking(text) {
  return String(text == null ? '' : text)
    .replace(RE_THINK_BLOCK, '')
    .replace(RE_THINK_TOKEN, '')
    .replace(RE_THINK_OPEN, '');
}

// 模型可能把 JSON 包在 ``` 里或前后带一句废话：只把第一个 {...} 抠出来（思考块先剥掉）。
// 拿不到可用答案时返回 null（调用方据此判定"这轮没结果"）
export function parseAiAnswer(text) {
  const m = stripThinking(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch { return null; }
  const pick = (v, max) => aiClean(v, max).replace(/^["'「『]+|["'」』]+$/g, '').trim();
  const company = pick(o.company, 60);
  const position = pick(o.position, 120);
  // 「不知道」不能当成一个答案送出去 —— 送出去的话，客户端会把它当成"这一页的答案"用
  const placeholder = /^(未知|不详|不确定|无法确定|无法识别|无|none|null|n\/a|-+|\?+)$/i;
  if (!company && !position) return null;
  return {
    company: placeholder.test(company) ? '' : company,
    position: placeholder.test(position) ? '' : position,
  };
}

// 发给模型的请求体。抽成纯函数是为了能单测（传输层只管发）
export function buildAiRequest(p, model, extra = AI_DEFAULT_EXTRA, { jsonMode = true } = {}) {
  return {
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: AI_PROMPT },
      { role: 'user', content: aiUserMessage(p) },
    ],
    ...(extra && typeof extra === 'object' ? extra : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

// 用户消息：一行一个字段。**格式别乱改** —— 量的是这一版的输入，
// 而且"一行一个字段"让上面 aiClean 的换行清理成为一道真实的结构防线
export function aiUserMessage(p) {
  return `网址 ${p.url}
标题「${p.title}」
公司候选 ${JSON.stringify(p.companyCandidates)}
岗位候选 ${JSON.stringify(p.positionCandidates)}`;
}

// ---------- 企业类型识别（/api/classify） ----------
// 与岗位识别**完全分开**：独立的提示词、独立的请求体、独立的解析（两个任务的判据不同，
// 一个是"抄页面上的原串"、一个是"给出页面外的枚举词"，混在一起有退化风险）

// 枚举必须与客户端 shared.js 的 NATURE_LIST / INDUSTRY_LIST 逐字一致 ——
// 由 tools/test-ai.mjs 断言三边（这里、core.js、shared.js）相同
export const NATURE_LIST = ['央企', '地方国企', '事业单位', '民企', '外企', '合资', '其他'];
export const INDUSTRY_LIST = [
  '互联网/科技', '电子/半导体', '通信/ICT', '汽车/新能源', '制造/工业', '能源/化工',
  '金融', '医药/医疗', '建筑/基建/地产', '快消/零售', '咨询/专业服务', '教育/科研',
  '交通/物流', '其他',
];

export const AI_CLASSIFY_PROMPT = `你是企业信息标注器。用户会给你一批**公司名称**（可能带「有限公司/集团」这类后缀），你要为每一家填两个字段：

· nature = 企业性质，只能从这七个里选一个：央企、地方国企、事业单位、民企、外企、合资、其他
  - 央企：国务院国资委/财政部直接监管的中央企业及其核心控股公司（例：国家电网、中国移动、中石油、中国建筑、中粮、招商局）
  - 地方国企：省/市/区县国资或地方政府控股（例：上汽集团、京东方、广州地铁、某市城市建设投资集团）
  - 事业单位：高校、科研院所、公立医院等非企业单位（例：某某大学、中科院某某研究所、某某市第一人民医院）
  - 民企：境内自然人或民营资本控股（例：字节跳动、比亚迪、三一重工、迈瑞医疗）
  - 外企：境外母公司控股，含外商独资（例：宝洁、西门子、三星、特斯拉）
  - 合资：中外双方合资经营（例：上汽大众、广汽本田、一汽丰田）
  - 其他：确定不属于以上任何一类时（股权高度分散、无实际控制人等）
· industry = 行业赛道，只能从这十四个里选一个：互联网/科技、电子/半导体、通信/ICT、汽车/新能源、制造/工业、能源/化工、金融、医药/医疗、建筑/基建/地产、快消/零售、咨询/专业服务、教育/科研、交通/物流、其他

判定顺序（重要）：
1. **先认公司**：这家公司你认识，就按你知道的事实填（例：宁德时代→民企、汽车/新能源；潍柴动力→地方国企、汽车/新能源）。
2. **认不出就按名称里的线索推**，线索只认**字面出现**的词：
   · 「银行/证券/保险/基金/信托/资管」→ 金融
   · 「医药/药业/制药/生物/医疗/医院/疫苗/器械」→ 医药/医疗
   · 「半导体/集成电路/芯片/微电子/光电/显示/存储/元器件/光学」→ 电子/半导体
   · 「通信/电信/光通信」→ 通信/ICT
   · 「汽车/整车/客车/重卡/动力电池/轮胎」→ 汽车/新能源
   · 「电网/电力/发电/核电/石油/石化/煤业/燃气/化工/环保」→ 能源/化工
   · 「建筑/建工/市政/路桥/隧道/设计院/地产/置业」→ 建筑/基建/地产
   · 「食品/饮料/乳业/酒业/日化/化妆品/零售/超市/餐饮/酒店」→ 快消/零售
   · 「咨询/会计师/律师/人力资源/检测/认证」→ 咨询/专业服务
   · 「大学/学院/学校/研究院/研究所/科学院」→ 教育/科研
   · 「物流/快递/航空/航运/港口/机场/铁路/地铁/轨道交通」→ 交通/物流
   · 「装备/机械/重工/机电/钢铁/材料/家电/工业/制造」→ 制造/工业
   · 名字以「中国XX」开头**不等于**央企（中国平安、中国恒大都不是），必须有把握才填央企。
3. **性质拿不准就留空，不要用「其他」凑数**：「其他」是"我确定它不属于前六类"，不是"我不知道"。
   行业同理：只能从名称看出个大概就留空，别硬塞。

其他要求：
· name 必须**原样回显**用户给你的那个名字，一个字都不要改、不要翻译、不要补全，也不要漏掉任何一家。
· 不确定的一律给空串 ""，**宁可留空也不许猜**。空串对用户是有用的信息（界面上显示「待确认」），猜错了则会把用户带偏。
· 每一家都要出现在 items 里，顺序与输入一致。

只输出 JSON，不要解释：{"items":[{"name":"公司名","nature":"民企","industry":"互联网/科技"}]}`;

// 主提示词说的是"只能从这七个/十四个里选一个"，而用户自定义的取值不在那两份里，
// 所以带自定义候选时**在末尾追加**这段把口径改成"合并" —— 只在带的时候追加（不带时逐字不变）
export const AI_CLASSIFY_EXTRA_RULE = `补充规则（只在这次的消息里给了「本次额外允许的取值」时适用）：那份清单是用户自己维护的分类写法，与上面的标准取值合并，一起构成这一次的候选集。判断每一家时先过一遍这份清单：只要某一家与清单里的某一项吻合（名字里带着它，或你判断它就属于这一类），就照它填进对应字段 —— 哪怕它看着不像标准意义上的「性质/行业」也不要跳过：用户把它列进来，就是认可这个写法。同一类既有标准写法又有自定义写法时，优先用自定义的那个写法。清单里没有吻合的项、标准取值里也拿不准时，才给空串。任何情况下都不许给出这两份清单之外的取值。消息里没有那份清单时，一切照旧。`;

// 用户消息里那块自定义候选的抬头（带自定义时才出现）。冒号是行内分隔符，
// 所以自定义值里**不允许出现冒号** —— 否则一个值就能伪造出一整行来（见 sanitizeCustomField）
const CLASSIFY_CUSTOM_HEAD = `本次额外允许的取值（用户自己维护的分类写法，与上面的标准取值合并构成本次的候选集；哪一家与其中某一项吻合就照它填，不要发明这之外的任何值）：`;

// 自定义候选的规模上限。与客户端 company-type.js 的 CUSTOM_MAX_ITEMS / CUSTOM_MAX_LEN 是同一组数
const CLASSIFY_MAX_CUSTOM_ITEMS = 40;
const CLASSIFY_MAX_CUSTOM_LEN = 20;

// 一批最多几家、每个名字最长多少字（超长名字只会白烧 token）
const CLASSIFY_MAX_ITEMS = 12;
const CLASSIFY_MAX_NAME_LEN = 60;

/**
 * 收敛自定义取值清单（用户自己划的分类）。**只收敛不判对错**：拿不准的丢掉。
 * 丢掉的四类：空值、与枚举重名的、带冒号的（能伪造提示词里的行）、重复的
 */
function sanitizeCustomField(raw, enums) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(raw) ? raw : []) {
    const s = aiClean(v, CLASSIFY_MAX_CUSTOM_LEN);
    if (!s || enums.indexOf(s) >= 0 || seen.has(s)) continue;
    if (/[:：]/.test(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= CLASSIFY_MAX_CUSTOM_ITEMS) break;
  }
  return out;
}

/**
 * 收敛分类请求。**只收敛不判对错**：拿不准的截断/丢弃，而不是整条请求失败。
 * @returns {{names:string[], custom?:{nature:string[],industry:string[]}}|null}
 *   一家都没有时返回 null；自定义清单两栏都空时**不带 custom 这个键**
 */
export function sanitizeClassifyPayload(body) {
  if (!body || typeof body !== 'object') return null;
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(body.names) ? body.names : []) {
    const s = aiClean(raw, CLASSIFY_MAX_NAME_LEN);
    if (s.length < 2) continue;                 // 一个字的名字没有判断价值
    const k = aiNorm(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= CLASSIFY_MAX_ITEMS) break;
  }
  if (!out.length) return null;
  const custom = {
    nature: sanitizeCustomField(body.custom?.nature, NATURE_LIST),
    industry: sanitizeCustomField(body.custom?.industry, INDUSTRY_LIST),
  };
  // 拼不拼自定义块，由**收敛后**的结果说了算，不由发没发说了算：
  // 于是"提示词里有什么"与"白名单收什么"永远同源
  const withCustom = custom.nature.length > 0 || custom.industry.length > 0;
  return withCustom ? { names: out, custom } : { names: out };
}

/** 这一次的候选集能不能用自定义块（提示词与白名单共用这一个判断）。 */
export function hasClassifyCustom(p) {
  return Boolean(p?.custom && (p.custom.nature?.length || p.custom.industry?.length));
}

// 用户消息：一行一家，行首带序号（序号只用来让模型别漏行 —— 回显校验走的是 name，不是序号）。
// 自定义候选取值附在同一段消息的末尾
export function classifyUserMessage(p) {
  const head = `公司名称（${p.names.length} 家）：\n${p.names.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
  if (!hasClassifyCustom(p)) return head;
  const lines = [];
  if (p.custom.nature.length) lines.push(`· 企业性质：${p.custom.nature.join('、')}`);
  if (p.custom.industry.length) lines.push(`· 行业赛道：${p.custom.industry.join('、')}`);
  return `${head}\n${CLASSIFY_CUSTOM_HEAD}\n${lines.join('\n')}`;
}

// 发给模型的请求体。max_tokens 比岗位识别大（12 家 × 两个字段），其余同款
export function buildClassifyRequest(p, model, extra = AI_DEFAULT_EXTRA, { jsonMode = true } = {}) {
  return {
    model,
    temperature: 0,
    max_tokens: 800,
    messages: [
      { role: 'system', content: AI_CLASSIFY_PROMPT + (hasClassifyCustom(p) ? '\n\n' + AI_CLASSIFY_EXTRA_RULE : '') },
      { role: 'user', content: classifyUserMessage(p) },
    ],
    ...(extra && typeof extra === 'object' ? extra : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

// 候选值比对用的"写法归一"：抹掉分隔符与句读（/ \ 、 ， 。 等）后小写。
// 它只抹**写法**，绝不做语义猜测 —— 不做包含/前缀匹配，所以「非金融」归一后是「非金融」，
// 不会对上「金融」。客户端 company-type.js 的 typeNorm 是同一套规则（同样由 test-ai.mjs 断言）
const TYPE_NORM_DROP = /[\s　/\\／＼、，,。.．·・|｜;；:："'“”‘’「」『』()（）\[\]【】\-—_－＿～〜]/g;
export const typeNorm = (x) => aiClean(x, 60).replace(TYPE_NORM_DROP, '').toLowerCase();

/**
 * 解析分类答案。两条硬规则，缺一不可：
 *   ① **回显校验**：答案里的 name 必须能对上这一次发出去的名字（归一化后相等），对不上的一律丢弃
 *   ② **候选集白名单**：nature/industry 必须命中「枚举 ∪ 这一次请求带来的自定义取值」，命中不了给空串。
 *      命中分两级：逐字命中优先；逐字不中再按 typeNorm 归一后**只允许唯一命中**；
 *      撞上的是「枚举 vs 自定义」时以**自定义**为准
 * @param {string} text 模型返回的原始文本
 * @param {string[]} names 这一次发出去的名字（回显校验用）
 * @param {{nature?:string[],industry?:string[]}} [custom] 本次允许的自定义取值（省缺＝只认枚举）
 * @returns {{name:string,nature:string,industry:string,said?:{nature?:string,industry?:string}}[]}
 */
export function parseClassifyAnswer(text, names, custom) {
  const m = stripThinking(text).match(/\{[\s\S]*\}/);
  if (!m) return [];
  let o;
  try { o = JSON.parse(m[0]); } catch { return []; }
  const items = Array.isArray(o?.items) ? o.items : (Array.isArray(o) ? o : []);
  const byNorm = new Map();
  for (const n of Array.isArray(names) ? names : []) byNorm.set(aiNorm(n), n);
  // 允许的取值：枚举 ∪ 本次请求带来的自定义（收敛过的那份）
  const natureList = custom?.nature?.length ? [...NATURE_LIST, ...custom.nature] : NATURE_LIST;
  const industryList = custom?.industry?.length ? [...INDUSTRY_LIST, ...custom.industry] : INDUSTRY_LIST;
  const pick = (v, list, enums) => {
    const s = aiClean(v, 40).replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!s) return '';
    if (list.indexOf(s) >= 0) return s;              // 逐字命中（含自定义值原样）
    const n = typeNorm(s);
    if (!n) return '';
    const hits = list.filter((c) => typeNorm(c) === n);
    if (!hits.length) return '';
    // 归一后撞了多个候选：优先用户自定义的那个；两个自定义撞在一起就丢掉，不猜
    const mine = hits.filter((c) => enums.indexOf(c) < 0);
    if (mine.length === 1) return mine[0];
    return hits.length === 1 ? hits[0] : '';
  };
  const out = [];
  const used = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const key = aiNorm(aiClean(it.name, CLASSIFY_MAX_NAME_LEN));
    const name = byNorm.get(key);
    if (!name || used.has(key)) continue;      // 回显对不上的、重复的 → 丢
    used.add(key);
    const nature = pick(it.nature, natureList, NATURE_LIST);
    const industry = pick(it.industry, industryList, INDUSTRY_LIST);
    // 被丢掉的栏：把模型的原话带出去（截断过、压过换行），界面据此说清"AI 答了、只是没采用"
    const said = {};
    const rawNature = aiClean(it.nature, 40);
    const rawIndustry = aiClean(it.industry, 40);
    if (!nature && rawNature) said.nature = rawNature;
    if (!industry && rawIndustry) said.industry = rawIndustry;
    const row = { name, nature, industry };
    if (said.nature || said.industry) row.said = said;
    out.push(row);
  }
  return out;
}
