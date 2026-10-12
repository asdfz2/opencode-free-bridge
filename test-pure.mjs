// 纯逻辑自测：不调模型、不占额度
process.env.WB_NO_LISTEN = '1';
const {
  splitContent, contentToText, normalizeTools,
  buildToolInstructions, parseToolCalls, buildPrompt,
} = await import('./bridge.mjs');

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name); }
};

console.log('== 1. 图片内容解析 ==');
{
  const r = splitContent([
    { type: 'text', text: '这是什么' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
  ]);
  check('提取出 2 张图片', r.images.length === 2);
  check('图片 uri 正确', r.images[0].startsWith('data:image/png') && r.images[1] === 'https://example.com/a.jpg');
  check('文字保留', r.text === '这是什么');
  const r2 = splitContent('纯文本');
  check('字符串内容兼容', r2.text === '纯文本' && r2.images.length === 0);
  const r3 = splitContent([{ type: 'image', source: { data: 'BBBB', media_type: 'image/jpeg' } }]);
  check('Anthropic 风格图片转 data URI', r3.images[0] === 'data:image/jpeg;base64,BBBB');
}

console.log('== 2. 工具归一化 ==');
{
  const tools = normalizeTools({
    tools: [
      { type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } },
    ],
  });
  check('解析出 1 个工具', tools && tools.length === 1 && tools[0].name === 'get_weather');
  check('tool_choice=none 时返回 null', normalizeTools({ tools: [{ function: { name: 'x' } }], tool_choice: 'none' }) === null);
  check('无 tools 返回 null', normalizeTools({}) === null);
  check('tool_choice 指定工具名时只留该工具', normalizeTools({
    tools: [{ function: { name: 'a' } }, { function: { name: 'b' } }],
    tool_choice: { type: 'function', function: { name: 'b' } },
  })?.length === 1);
}

console.log('== 3. 工具调用输出解析 ==');
{
  const tools = [{ name: 'get_weather', parameters: {} }, { name: 'search', parameters: {} }];
  const okJson = '{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}}]}';
  const r1 = parseToolCalls(okJson, tools);
  check('纯 JSON 工具调用', r1 && r1.calls.length === 1 && r1.calls[0].name === 'get_weather' && r1.calls[0].arguments.city === '北京');
  const r2 = parseToolCalls('我来查一下\n' + okJson + '\n好了', tools);
  check('文字中嵌入 JSON', r2 && r2.calls.length === 1);
  const r3 = parseToolCalls('好的，北京今天晴。', tools);
  check('普通回复不误解', r3 === null);
  const r4 = parseToolCalls('{"tool_calls":[{"name":"不存在的工具","arguments":{}}]}', tools);
  check('未知工具名拒绝', r4 === null);
  const r5 = parseToolCalls('{"tool_calls":[{"name":"get_weather","arguments":"{\\"city\\":\\"上海\\"}"}]}', tools);
  check('arguments 为字符串时解析', r5 && r5.calls[0].arguments.city === '上海');
  const r6 = parseToolCalls('{"tool_calls":[{"name":"get_weather","arguments":{"city":"北京"}},{"name":"search","arguments":{"q":"天气"}}]}', tools);
  check('多个工具调用', r6 && r6.calls.length === 2);
}

console.log('== 4. 提示词组装（含工具历史） ==');
{
  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '北京天气如何' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"temp":26,"cond":"晴"}' },
    { role: 'user', content: '那上海呢' },
  ];
  const tools = normalizeTools({ tools: [{ function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] });
  const p = buildPrompt(messages, tools, { tools: true });
  check('含系统设定', p.text.includes('你是助手'));
  check('含历史工具调用记录', p.text.includes('请求调用工具') && p.text.includes('get_weather'));
  check('含工具执行结果', p.text.includes('的执行结果]') && p.text.includes('26'));
  check('含工具调用规则', p.text.includes('tool_calls'));
  check('最后问题正确', p.text.includes('那上海呢'));
}

console.log('== 5. 工具结果续轮（最后一条是 tool 消息） ==');
{
  const messages = [
    { role: 'user', content: '北京天气如何' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"temp":26,"cond":"晴"}' },
  ];
  const tools = normalizeTools({ tools: [{ function: { name: 'get_weather', description: '查天气', parameters: {} } }] });
  const p = buildPrompt(messages, tools, { tools: true });
  check('工具结果进入上下文', p.text.includes('的执行结果]') && p.text.includes('26'));
  check('工具调用记录进入上下文', p.text.includes('请求调用工具'));
  check('包含续轮指令', p.text.includes('工具执行结果') && p.text.includes('不要重复调用'));
  check('不重复原始问题为当前问题', p.text.includes('【当前问题】\n（请基于'));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
