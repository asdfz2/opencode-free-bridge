// 回归：普通聊天 + 图片理解（走真实 HTTP 接口）
const KEY = 'wb2026free';
const URL = 'http://127.0.0.1:10000/v1/chat/completions';
const MODEL = process.argv[2] || 'space-bunny-free';

async function call(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

console.log('--- 普通聊天 ---');
const chat = await call({ model: MODEL, messages: [{ role: 'user', content: '用一句话说说自由模型的优缺点' }], stream: false });
console.log(chat.choices?.[0]?.message?.content?.slice(0, 200) || JSON.stringify(chat.error));

console.log('\n--- 图片理解（自包含 2x2 橙红图片）---');
const PNG_2x2 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAARSURBVBhXY/gQYPMfhBlgDABZLAntypBpDQAAAABJRU5ErkJggg==';
const img = await call({
  model: MODEL,
  stream: false,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图是什么颜色？一句话回答。' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG_2x2 } },
      ],
    },
  ],
});
console.log(img.choices?.[0]?.message?.content?.slice(0, 200) || JSON.stringify(img.error));