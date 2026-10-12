// 验证"等待本轮真正结束"在无工具路径也生效：
// 这个问题会诱导模型去用内置工具，早期版本会返回空（"模型没有返回文字内容"）
const KEY = 'wb2026free';
const URL = 'http://127.0.0.1:10000/v1/chat/completions';
const MODEL = process.argv[2] || 'space-bunny-free';

const res = await fetch(URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    messages: [{ role: 'user', content: '请查看当前目录下有哪些文件，并简要说明每个文件是干什么的。' }],
  }),
});
const j = await res.json();
const c = j.choices?.[0];
console.log(c ? 'finish: ' + c.finish_reason + '\n回复: ' + String(c.message.content).slice(0, 300) : '错误: ' + JSON.stringify(j.error));