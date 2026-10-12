// 端到端验证：完全按 OpenAI 协议模拟 WorkBuddy 的多轮工具循环
import { writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:10000/v1/chat/completions';
const KEY = 'wb2026free';
const MODEL = process.argv[2] || 'space-bunny-free';

const tools = [
  { name: 'aihot_items', description: '拉取 AI HOT 收录的论文/资讯列表。参数 days 天数、limit 数量', p: { days: 'integer', limit: 'integer' } },
  { name: 'aihot_search', description: '检索论文。参数 query 关键词', p: { query: 'string' } },
  { name: 'file_write', description: '把内容写入指定路径的文件。参数 path 路径、content 内容', p: { path: 'string', content: 'string' } },
  { name: 'file_read', description: '读取文件。参数 path 路径', p: { path: 'string' } },
  { name: 'file_list', description: '列出目录文件。参数 path 目录', p: { path: 'string' } },
  { name: 'web_search', description: '联网搜索。参数 query 关键词', p: { query: 'string' } },
  { name: 'web_fetch', description: '抓取网页正文。参数 url 网址', p: { url: 'string' } },
  { name: 'image_generate', description: '生成图片。参数 prompt 描述', p: { prompt: 'string' } },
  { name: 'shell_exec', description: '执行系统命令。参数 command 命令', p: { command: 'string' } },
  { name: 'todo_create', description: '创建待办。参数 title 标题', p: { title: 'string' } },
  { name: 'todo_list', description: '列出待办。参数：无', p: {} },
  { name: 'calendar_add', description: '新建日历事件。参数 title、start', p: { title: 'string', start: 'string' } },
  { name: 'calendar_list', description: '查询日历。参数 range 范围', p: { range: 'string' } },
  { name: 'mail_send', description: '发邮件。参数 to、subject、body', p: { to: 'string', subject: 'string', body: 'string' } },
  { name: 'mail_search', description: '搜邮件。参数 query', p: { query: 'string' } },
  { name: 'doc_create', description: '建在线文档。参数 title、content', p: { title: 'string', content: 'string' } },
  { name: 'doc_read', description: '读在线文档。参数 id', p: { id: 'string' } },
  { name: 'note_create', description: '建笔记。参数 title、body', p: { title: 'string', body: 'string' } },
  { name: 'sheet_write', description: '写表格。参数 id、rows', p: { id: 'string', rows: 'array' } },
  { name: 'sheet_read', description: '读表格。参数 id、range', p: { id: 'string', range: 'string' } },
  { name: 'translate', description: '翻译。参数 text、to', p: { text: 'string', to: 'string' } },
  { name: 'summarize', description: '总结。参数 text、length', p: { text: 'string', length: 'string' } },
  { name: 'reminder_set', description: '设提醒。参数 content、time', p: { content: 'string', time: 'string' } },
  { name: 'contact_query', description: '查联系人。参数 keyword', p: { keyword: 'string' } },
  { name: 'task_create', description: '建任务。参数 title、due', p: { title: 'string', due: 'string' } },
].map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.p).map(([k, v]) => [k, { type: v }])),
    },
  },
}));

const SYSTEM =
  '你是 WorkBuddy 的 AI 助手，一个能调用工具完成实际工作的智能体。' +
  '遇到需要外部数据或需要产出文件的任务，先调用对应工具，再基于结果用自然语言汇报。';

async function post(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postStream(body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let toolCalls = [];
  let finish = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    for (const c of chunks) {
      const line = c.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      const ch = j.choices?.[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      if (ch.delta?.content) content += ch.delta.content;
      if (ch.delta?.tool_calls?.length) {
        for (const tc of ch.delta.tool_calls) toolCalls.push(tc);
      }
    }
  }
  return { content, toolCalls, finish };
}

const messages = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: '帮我盘点最近 7 天的 AI 论文，并用 file_write 生成一个单文件 HTML 学术档案库。' },
];

console.log('模型:', MODEL, '| 工具数:', tools.length);

console.log('\n===== 第 1 轮（非流式）=====');
const r1 = await post({ model: MODEL, messages, tools, stream: false });
const c1 = r1.choices?.[0];
if (!c1) {
  console.log('错误:', JSON.stringify(r1.error));
  process.exit(1);
}
console.log('finish_reason:', c1.finish_reason);
if (c1.message.tool_calls?.length) {
  console.log('工具调用:', c1.message.tool_calls.map((t) => `${t.function.name}(${t.function.arguments})`).join(' , '));
} else {
  console.log('文本:', String(c1.message.content).slice(0, 200));
}

if (c1.message.tool_calls?.length) {
  messages.push({ role: 'assistant', content: c1.message.content || null, tool_calls: c1.message.tool_calls });
  const TOOL_RESULTS = {
    aihot_items: JSON.stringify([
      { id: 'p1', title: 'Scaling Laws for Neural Language Models', org: 'OpenAI', date: '2026-10-05', tags: ['LLM'] },
      { id: 'p2', title: 'Agentic RL with Tool Use', org: 'DeepMind', date: '2026-10-07', tags: ['Agent'] },
      { id: 'p3', title: 'Efficient Long-Context Attention', org: 'Meta', date: '2026-10-08', tags: ['Attention'] },
    ]),
    file_write: '已写入 ./output/ai-paper-archive.html（12.4 KB）',
    aihot_search: '[]',
  };
  for (let round = 2; round <= 4; round++) {
    const pending = [...messages].reverse().find((m) => m.role === 'assistant' && m.tool_calls?.length);
    const call = pending.tool_calls[pending.tool_calls.length - 1].function.name;
    messages.push({ role: 'tool', tool_call_id: pending.tool_calls[pending.tool_calls.length - 1].id || 'call_' + round, name: call, content: TOOL_RESULTS[call] || '已完成' });
    console.log(`\n===== 第 ${round} 轮（流式，回传 ${call} 结果后）=====`);
    const r = await postStream({ model: MODEL, messages, tools, stream: true });
    console.log('finish_reason:', r.finish, '| 文本长度:', r.content.length);
    if (r.toolCalls.length) {
      console.log('工具调用:', r.toolCalls.map((t) => `${t.function.name}(${String(t.function.arguments).slice(0, 80)})`).join(' , '));
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: r.toolCalls.map((t, i) => ({ id: t.id || 'call_' + round + '_' + i, type: 'function', function: { name: t.function.name, arguments: t.function.arguments } })),
      });
      continue;
    }
    // 文本形态的原始输出落盘，便于分析是否被截断
    writeFileSync('last-text-output.txt', r.content);
    console.log('最终答复(前 200):', r.content.slice(0, 200));
    console.log('最终答复(末 200):', r.content.slice(-200));
    break;
  }
}