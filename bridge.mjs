/**
 * wb-bridge — WorkBuddy ↔ opencode 免费模型 桥接器（完整版）
 *
 * 功能：
 *  - OpenAI 兼容 /v1/chat/completions（流式 SSE + 非流式）
 *  - 图片输入：WorkBuddy 的 image_url（data:/http）直接转成 opencode 附件
 *  - 工具调用：WorkBuddy 传来的 tools 以“提示词约定”方式桥接，
 *    模型按约定输出 JSON → 桥接转成标准 tool_calls 返回
 *
 * 零费用：只用 opencode 内置匿名免费模型。只监听 127.0.0.1。
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, appendFileSync, statSync } from 'node:fs';
import { OpenCode } from '@opencode/client';

// ---------- 配置 ----------
const PORT = Number(process.env.WB_PORT || 10000);
const BRIDGE_KEY = process.env.WB_KEY || 'wb2026free';
const BACKEND_URL = process.env.WB_BACKEND_URL || 'http://127.0.0.1:10001';
// 本地配置文件（与 launch-backend.mjs 共用同一份，保证密码/数据目录一致）
let localCfg = {};
try {
  localCfg = JSON.parse(readFileSync(new URL('./config.local.json', import.meta.url), 'utf8'));
} catch { /* 配置文件缺失时退回环境变量 */ }
const BACKEND_PASSWORD = localCfg.backendPassword || process.env.OPENCODE_SERVER_PASSWORD || '';
const DEFAULT_MODEL = process.env.WB_DEFAULT_MODEL || 'opencode/longcat-2.5-preview-free';
const REQUEST_TIMEOUT_MS = Number(process.env.WB_TIMEOUT_MS || 150000);

const basicAuth = BACKEND_PASSWORD
  ? { Authorization: 'Basic ' + Buffer.from(`opencode:${BACKEND_PASSWORD}`).toString('base64') }
  : {};

const rawClient = OpenCode.make({ baseUrl: BACKEND_URL });
const client = {};
for (const [group, methods] of Object.entries(rawClient)) {
  if (methods && typeof methods === 'object') {
    client[group] = {};
    for (const [name, fn] of Object.entries(methods)) {
      client[group][name] =
        typeof fn === 'function' ? (input, opts) => fn(input, { headers: basicAuth, ...opts }) : fn;
    }
  } else {
    client[group] = methods;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同时写一份到 bridge.log，方便事后查故障（窗口被最小化时看不到控制台）
const LOG_FILE = new URL('./bridge.log', import.meta.url);
function log(...args) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
  console.log(line);
  try {
    appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志失败不影响服务 */ }
}
const newId = (p) => p + randomUUID().replace(/-/g, '').slice(0, 22);

// ---------- 模型目录 ----------
async function listModels() {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await client.model.list();
      const arr = res.data || [];
      if (arr.length) return arr;
    } catch (e) {
      log('[models] 第', i + 1, '次失败:', e.message?.slice(0, 100));
    }
    await sleep(2000);
  }
  return [];
}

// ---------- 内容解析：文字 + 图片 ----------
// OpenAI content 可能是字符串或段数组；段类型：text / image_url / image(Anthropic 风格) / input_image 等
function splitContent(content) {
  const out = { text: '', images: [] };
  if (typeof content === 'string') { out.text = content; return out; }
  if (!Array.isArray(content)) { out.text = content == null ? '' : String(content); return out; }

  const texts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && p.text) { texts.push(p.text); continue; }
    // OpenAI 风格 image_url
    if (p.type === 'image_url') {
      const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (u) out.images.push(u);
      continue;
    }
    // Anthropic 风格 image（source.data + media_type）
    if (p.type === 'image') {
      const src = p.source || {};
      if (typeof src.url === 'string') out.images.push(src.url);
      else if (src.data && src.media_type) out.images.push(`data:${src.media_type};base64,${src.data}`);
      continue;
    }
    if (p.type === 'input_image' && p.image_url) {
      const u = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (u) out.images.push(u);
    }
  }
  out.text = texts.join('\n');
  return out;
}

function contentToText(content) {
  const { text, images } = splitContent(content);
  if (images.length) return `${text}\n[历史消息中含 ${images.length} 张图片]`.trim();
  return text;
}

// ---------- 工具归一化 ----------
function normalizeTools(json) {
  const choice = json.tool_choice;
  if (choice === 'none' || choice === false) return null;
  let tools = Array.isArray(json.tools) ? json.tools : [];
  const list = [];
  for (const t of tools) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    list.push({
      name: String(fn.name),
      description: String(fn.description || '').slice(0, 500),
      parameters: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
    });
  }
  if (!list.length) return null;
  // 指定了具体工具时，只保留它
  if (choice && typeof choice === 'object' && choice.function?.name) {
    const only = list.filter((t) => t.name === choice.function.name);
    return only.length ? only : null;
  }
  return list;
}

function buildToolInstructions(tools, json) {
  const lines = tools.map(
    (t, i) => `${i + 1}. ${t.name}\n   说明：${t.description || '（无）'}\n   参数 JSON Schema：${JSON.stringify(t.parameters)}`
  );
  let instr =
    `\n\n【工具调用规则】\n你可以使用以下工具。当你需要调用工具时，你的整个回复必须且只能是一个 JSON 对象（不要有任何其他文字、不要用代码块包裹），格式：\n` +
    `{"tool_calls":[{"name":"<工具名>","arguments":{<参数对象>}}]}\n` +
    `一次可以调用多个。参数名和结构必须符合上面的 Schema。\n` +
    `参数里的长文本要精炼（例如写文件时正文请控制在 4000 字以内），过长的 JSON 会被中途截断导致调用失败。\n` +
    `如果对话历史中已经有某个工具的执行结果，直接基于结果继续，不要重复调用。\n` +
    `不需要调用工具时，用自然语言正常回答。\n\n【可用工具】\n${lines.join('\n')}`;
  const choice = json.tool_choice;
  if (choice && typeof choice === 'object' && choice.function?.name) {
    instr += `\n\n注意：本次必须调用工具「${choice.function.name}」。`;
  }
  return instr;
}

// ---------- 解析模型输出里的工具调用 ----------
function parseToolCalls(text, tools) {
  if (!text) return null;
  const names = new Set(tools.map((t) => t.name));
  const tryParse = (str) => {
    try {
      const obj = JSON.parse(str);
      const arr = Array.isArray(obj) ? obj : obj?.tool_calls;
      if (!Array.isArray(arr) || !arr.length) return null;
      const calls = [];
      for (const c of arr) {
        const name = c?.name || c?.function?.name;
        if (!name || !names.has(name)) return null;
        let args = c.arguments ?? c.function?.arguments ?? {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { return null; }
        }
        calls.push({ name, arguments: args });
      }
      return calls;
    } catch {
      return null;
    }
  };
  // 1) 整个回复就是 JSON
  let calls = tryParse(text.trim());
  if (calls) return { calls, prose: '' };
  // 2) 回复里嵌了 JSON 对象（按括号配对扫描，容忍前后有说明文字）
  const spans = extractJsonObjects(text);
  for (const sp of spans) {
    calls = tryParse(text.slice(sp.start, sp.end));
    if (calls) return { calls, prose: text.slice(0, sp.start).trim() };
  }
  // 3) 容错：tool_calls 数组被截断时，至少把能读到的调用救出来
  calls = salvageCalls(text, names);
  if (calls?.length) return { calls, prose: '' };
  return null;
}

// 扫描出所有括号配对的 {...} 片段（跳过字符串里的括号）
function extractJsonObjects(text) {
  const spans = [];
  const stack = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') stack.push(i);
    else if (ch === '}') {
      const start = stack.pop();
      if (start !== undefined) spans.push({ start, end: i + 1 });
    }
  }
  // 从大到小：先试外层对象
  return spans.sort((a, b) => b.end - b.start - (a.end - a.start));
}

// 从可能不完整/被截断的输出里尽力提取工具调用
function salvageCalls(text, names) {
  const found = [];
  const re = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(text))) {
    if (names.has(m[1])) found.push({ name: m[1], arguments: {} });
  }
  return found.length ? found : null;
}

// ---------- 历史 → 提示词 ----------
function buildPrompt(messages, tools, json) {
  const system = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).join('\n');
  const history = messages.filter((m) => m.role !== 'system');
  if (!history.length) throw Object.assign(new Error('messages 里没有 user 消息'), { statusCode: 400 });

  // 判断是否"工具结果回传后的续轮"（最后一条是工具结果，或带 tool_calls 的助手消息）
  const lastMsg = history[history.length - 1];
  const isToolContinuation =
    lastMsg.role === 'tool' ||
    (lastMsg.role === 'assistant' && Array.isArray(lastMsg.tool_calls) && lastMsg.tool_calls.length > 0);

  let historyMsgs = history;
  let images = [];
  let question = '';

  if (isToolContinuation) {
    // 续轮：全部历史作为上下文。允许继续链式调用（比如"取数据 → 写文件"），
    // 但禁止重复调用已经执行过的工具；信息够了就直接收尾。
    question =
      '（请基于上面已给出的工具执行结果继续完成用户的要求：' +
      '如果确实还需要别的工具（例如把结果写入文件），就按规则输出工具调用 JSON，且不要重复调用上面已经执行过的工具；' +
      '如果信息已经足够，就直接给出面向用户的最终答复，不要再输出 JSON。）';
  } else {
    // 常规轮：最后一条 user 消息是当前问题，之前的全部进历史
    const lastUserIdx = history.map((m) => m.role).lastIndexOf('user');
    if (lastUserIdx < 0) throw Object.assign(new Error('messages 里没有 user 消息'), { statusCode: 400 });
    historyMsgs = history.slice(0, lastUserIdx);
    const lastSplit = splitContent(history[lastUserIdx].content);
    question = lastSplit.text;
    images = lastSplit.images;
    if (images.length) question += `\n（用户本条消息附带了 ${images.length} 张图片，已作为附件传入，请结合图片内容回答）`;
  }

  let context = '';
  for (const m of historyMsgs) {
    if (m.role === 'tool') {
      const name = m.name || m.tool_call_id || 'tool';
      context += `[工具 ${name} 的执行结果] ${contentToText(m.content)}\n`;
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      for (const tc of m.tool_calls) {
        context += `助手：[请求调用工具] ${tc.function?.name || '?'} 参数：${tc.function?.arguments || '{}'}\n`;
      }
      if (m.content) context += `助手：${contentToText(m.content)}\n`;
    } else {
      context += `${m.role === 'user' ? '用户' : '助手'}：${contentToText(m.content)}\n`;
    }
  }

  const parts = [];
  if (system) parts.push(`【系统设定】\n${system}`);
  if (context) parts.push(`【对话历史】\n${context.trim()}`);
  parts.push(`【当前问题】\n${question}`);
  if (tools) parts.push(buildToolInstructions(tools, json));
  else {
    // 没有工具时明确掐掉"翻文件 / 跑命令 / 联网查"的念头：
    // 否则模型会去用内置工具，答案里混进"我查了目录""达到步数上限"这类内部话术
    parts.push(
      '【本次说明】本次没有任何可用工具：请不要尝试读取文件、执行命令或联网查询，直接基于你已有的知识用自然语言回答。'
    );
  }
  return { text: parts.join('\n\n'), images };
}

// ---------- 模型名解析 ----------
function parseModel(model) {
  const raw = (model || DEFAULT_MODEL).trim();
  if (raw.includes('/')) {
    const idx = raw.indexOf('/');
    return { providerID: raw.slice(0, idx), id: raw.slice(idx + 1) };
  }
  return { providerID: 'opencode', id: raw };
}

// ---------- 核心：建会话 → 提问 → 等"本轮真正结束" ----------
// 关键点：opencode 一轮里可能产生多条助手消息——模型若中途调用了内置工具，
// 会先产出 finish=tool-calls 的中间消息，之后会话还会继续。
// 真正结束的那条 finish 才是 stop（正常收尾）或 error。
// 早停只会拿到"只有工具、没有文字"的中间消息，于是误报"模型没有返回文字内容"。
async function runTurn(model, promptText, images, onTick, onPartial) {
  let session;
  try {
    // 桥接专用 agent（见 .opencode/agents/wbbridge.md）：
    // 系统提示约束模型只走 JSON 工具协议；steps:2 限制它最多走两步
    session = await client.session.create({ model, agent: 'wbbridge' });
  } catch (e) {
    // agent 文件未被发现（启动目录变化等）时回退默认 agent，保证基本可用
    log('[chat] 专用 agent 不可用，回退默认 agent:', e.message?.slice(0, 80));
    session = await client.session.create({ model });
  }
  const sessionID = session.id || session.sessionID;
  if (!sessionID) throw new Error('建会话失败');

  const promptInput = { sessionID, id: newId('msg_'), text: promptText };
  if (images && images.length) {
    promptInput.files = images.map((u, i) => ({ uri: u, name: `image_${i + 1}` }));
    log('[chat] 附带图片', images.length, '张');
  }
  await client.session.prompt(promptInput);

  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let latestText = '';
  let finalText = '';
  let errorInfo = null;
  let done = false;
  const nativeTools = [];

  while (Date.now() < deadline && !done) {
    await sleep(1000);
    if (onTick) onTick();
    let items = [];
    try {
      const page = await client.message.list({ sessionID });
      items = page.data || [];
    } catch (e) {
      log('[poll] 失败:', e.message?.slice(0, 80));
      continue;
    }
    for (const item of items) {
      if (item.type !== 'assistant') continue;
      const parts = Array.isArray(item.content) ? item.content : [];
      const text_ = parts.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join('');
      for (const p of parts) {
        if (p && p.type === 'tool' && p.name && !nativeTools.includes(p.name)) nativeTools.push(p.name);
      }
      // 模型在用内置工具时，屏蔽中间消息的文字，避免把"我来看看目录"这类过程话术流给用户
      const canStream = onPartial && nativeTools.length === 0;

      if (!item.time || !item.time.completed) {
        if (canStream && text_ && text_ !== latestText) { latestText = text_; onPartial(text_); }
        continue;
      }
      const finish = item.finish || '';
      if (finish === 'tool-calls') {
        // 中间消息：本轮还没结束，继续等
        if (canStream && text_ && text_ !== latestText) { latestText = text_; onPartial(text_); }
        continue;
      }
      done = true;
      if (finish === 'error') {
        const err = item.error || {};
        errorInfo = { message: err.message || '模型调用失败', status: typeof err.status === 'number' ? err.status : 502 };
      } else {
        finalText = text_;
        if (onPartial && text_ && text_ !== latestText) onPartial(text_);
      }
    }
  }

  await client.session.remove({ sessionID }).catch(() => {});
  return { text: finalText, nativeTools, errorInfo, timedOut: !done };
}

async function runChat(json, tools, onTick, onPartial) {
  const model = parseModel(json.model);
  const { text, images } = buildPrompt(json.messages || [], tools, json);

  let turn = await runTurn(model, text, images, onTick, tools ? undefined : onPartial);

  // 模型误用了 opencode 内置工具（结果 WorkBuddy 收不到）→ 纠正后重试一次
  if (tools && turn.nativeTools.length && !turn.errorInfo && !parseToolCalls(turn.text, tools)) {
    log('[chat] 模型误用内置工具（' + turn.nativeTools.join(',') + '），纠正后重试');
    const correction =
      '【重要纠正】你上一次的尝试出错了：那些内置工具（' +
      turn.nativeTools.join('、') +
      '）不属于本次对话，客户端完全收不到它们的结果，必须完全避免，不要再尝试读取文件、执行命令或浏览目录。\n' +
      '现在只允许两种输出：需要工具时输出 {"tool_calls":[{"name":"<工具名>","arguments":{...}}]}；不需要时直接写最终答复。\n\n';
    turn = await runTurn(model, correction + text, images, onTick, undefined);
  }

  if (turn.errorInfo) throw Object.assign(new Error(turn.errorInfo.message), { statusCode: turn.errorInfo.status });
  if (turn.timedOut) throw Object.assign(new Error('模型响应超时（' + REQUEST_TIMEOUT_MS / 1000 + 's）'), { statusCode: 504 });

  const content = turn.text;

  // 有工具时尝试解析工具调用
  if (tools) {
    const parsed = parseToolCalls(content, tools);
    if (parsed && parsed.calls.length) {
      return {
        content: parsed.prose || null,
        toolCalls: parsed.calls.map((c) => ({
          id: newId('call_'),
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      };
    }
    if (!content) {
      const why = turn.nativeTools.length
        ? '模型两次都没有按工具协议输出（一直在用内置工具）。这个模型可能不适合带工具的任务，建议换 longcat 或 step-5。'
        : '模型这次没有返回任何内容，请重试或换一个模型。';
      throw Object.assign(new Error(why), { statusCode: 502 });
    }
  }
  return { content: content || '（模型没有返回文字内容）', toolCalls: null };
}

// ---------- SSE 写入器 ----------
function sseWriter(res, modelName) {
  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => {
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
        }) +
        '\n\n'
    );
  };
  const toolChunk = (tc, index) => {
    res.write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }) +
        '\n\n'
    );
  };
  return { chunk, toolChunk };
}

// 供本地自测导入（WB_NO_LISTEN=1 时不启动服务）
export {
  splitContent, contentToText, normalizeTools,
  buildToolInstructions, parseToolCalls, buildPrompt, parseModel,
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/health') {
    try {
      const models = await listModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, models: models.length }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.headers.authorization !== `Bearer ${BRIDGE_KEY}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '密码不对，请使用 WorkBuddy 里配置的 API Key' } }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const models = await listModels();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: models.map((m) => ({
        id: `${m.providerID}/${m.id}`,
        object: 'model',
        created: 1704067200,
        owned_by: m.providerID,
        // opencode 系列统一显示名 OpenCode（与 WorkBuddy 配置保持一致，防同步覆盖）；
        // 其他 provider 用 "provider · model-id"
        name: m.providerID === 'opencode' ? 'OpenCode' : `${m.providerID} · ${m.id}`,
      })),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let json = {};
      try {
        json = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON' } }));
        return;
      }
      const modelName = json.model || DEFAULT_MODEL;
      const stream = json.stream === true;
      const tools = normalizeTools(json);
      log('[chat] 模型:', modelName, '| 消息数:', (json.messages || []).length,
        '| 流式:', stream ? '是' : '否', '| 工具数:', tools ? tools.length : 0);

      // ===== 流式 =====
      if (stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const { chunk, toolChunk } = sseWriter(res, modelName);
        chunk({ role: 'assistant' }); // 立即建立流

        const hb = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
        }, 3000);

        try {
          if (tools) {
            // 有工具：等全文 → 解析 → 发 tool_calls 或文字
            const result = await runChat(json, tools);
            clearInterval(hb);
            if (result.toolCalls?.length) {
              result.toolCalls.forEach((tc, i) => toolChunk(tc, i));
              chunk({}, 'tool_calls');
            } else {
              const STEP = 24;
              const c = result.content || '';
              for (let i = 0; i < c.length; i += STEP) chunk({ content: c.slice(i, i + STEP) });
              chunk({}, 'stop');
            }
          } else {
            // 无工具：渐进式流式输出
            let sentLen = 0;
            const result = await runChat(json, null, undefined, (full) => {
              const fresh = full.slice(sentLen);
              if (!fresh) return;
              const STEP = 24;
              for (let i = 0; i < fresh.length; i += STEP) chunk({ content: fresh.slice(i, i + STEP) });
              sentLen = full.length;
            });
            clearInterval(hb);
            if (result.content.length > sentLen) {
              const fresh = result.content.slice(sentLen);
              const STEP = 24;
              for (let i = 0; i < fresh.length; i += STEP) chunk({ content: fresh.slice(i, i + STEP) });
            }
            chunk({}, 'stop');
          }
          res.write('data: [DONE]\n\n');
          res.end();
          log('[chat] 流式完成');
        } catch (e) {
          clearInterval(hb);
          log('[chat] 错误:', e.message?.slice(0, 200));
          chunk({ content: `\n[出错] ${e.message}` });
          chunk({}, 'stop');
          res.write('data: [DONE]\n\n');
          res.end();
        }
        return;
      }

      // ===== 非流式 =====
      try {
        const result = await runChat(json, tools);
        const choice = result.toolCalls?.length
          ? {
              index: 0,
              message: { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls },
              finish_reason: 'tool_calls',
            }
          : {
              index: 0,
              message: { role: 'assistant', content: result.content },
              finish_reason: 'stop',
            };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 12),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [choice],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }));
        log('[chat] 完成 | 工具调用:', result.toolCalls?.length || 0);
      } catch (e) {
        log('[chat] 错误:', e.message?.slice(0, 200));
        res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message || '内部错误' } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: '接口不存在：' + url.pathname } }));
});

if (!process.env.WB_NO_LISTEN) {
  server.listen(PORT, '127.0.0.1', () => {
    log(`桥接已启动: http://127.0.0.1:${PORT}（支持图片/工具/流式）`);
    log(`后端: ${BACKEND_URL} | 默认模型: ${DEFAULT_MODEL} | 密码: ${BRIDGE_KEY}`);
  });
}
