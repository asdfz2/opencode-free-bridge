# opencode-free-bridge

在本地把 [OpenCode](https://opencode.ai) 的**免费模型**暴露成一个 OpenAI 兼容接口，
让任何 AI agent 或客户端（WorkBuddy、Cherry Studio、NextChat、自研程序……）都能零费用调用。

```
AI 客户端 ──OpenAI 协议──▶ 桥接 (127.0.0.1:10000) ──▶ opencode serve (127.0.0.1:10001) ──▶ OpenCode 免费额度
```

## 功能

- **OpenAI 兼容**：`/v1/chat/completions`（流式 SSE + 非流式）、`/v1/models`
- **图片输入**：`image_url`（data: / http(s)）直接转成 opencode 附件
- **工具调用**：客户端的 `tools` 以"提示词约定"桥接——模型按约定输出 JSON，桥接转成标准 `tool_calls` 返回；支持多轮循环（取数 → 写文件 → 总结）
- **会话隔离**：桥接使用独立数据目录，会话不污染 opencode 主库
- **专用 agent**：内置 `.opencode/agents/wbbridge.md`，约束模型只走 JSON 协议，不去调用 opencode 自带的内置工具

## 运行前提

- Windows（启动脚本为 `.cmd`；Linux/macOS 需自行改写启动脚本）
- Node.js ≥ 20
- 本机装有 **opencode CLI v2**（从 opencode 官网安装，桥接只调用它的 `serve` 命令）

## 快速开始

```bash
git clone https://github.com/<你的用户名>/opencode-free-bridge.git
cd opencode-free-bridge
npm install
copy config.local.example.json config.local.json
# 编辑 config.local.json，填入：
#   backendPassword : 任意强密码（桥接与后端之间的内部口令）
#   opencodePath    : opencode.exe 的完整路径
notepad config.local.json
start.cmd          # 一键启动（先清旧实例 → 启后端 → 启桥接 → 自检）
```

启动后自检通过会显示在线模型数。停止用 `stop.cmd`。

## 客户端配置

| 项 | 值 |
|---|---|
| 接口地址 | `http://127.0.0.1:10000/v1` |
| API 密钥 | `wb2026free`（默认值；桥接仅监听本机，但建议首次使用时在 `bridge.mjs` 顶部 `BRIDGE_KEY` 改成自己的） |
| 模型名 | `opencode/longcat-2.5-preview-free`、`opencode/step-5-preview-free`、`opencode/mimo-v2.6-flash-free`、`opencode/big-pickle`、`opencode/space-bunny-free` 等（以 `/v1/models` 返回为准） |

模型能力（图片/工具/推理支持）以 opencode 官方目录为准。

## ⚠️ 合规与风险声明

- **仅供本地个人使用，自行评估风险。** OpenCode 的免费额度是 opencode 官方提供给
  OpenCode 客户端用户的福利；本桥接通过本机 opencode 服务器转发请求，
  **不伪造任何身份信息**（请求身份一律由官方 CLI 注入），但把免费额度转给
  其他客户端使用是否符合 opencode 的服务条款，请自行评估后再用。
- 免费模型按 IP 限流（429 属正常现象），请勿高频滥用。
- 免费模型可能把对话内容用于模型改进，涉密内容请使用你自有的付费模型。
- 本项目与 OpenCode、WorkBuddy 无官方关联。

## 工作原理（工具调用）

opencode 的免费层只认官方 CLI 的会话通道（直接 HTTP 调模型会被 403 拒绝），
所以桥接在本地拉起一个 opencode 服务器，再把 OpenAI 协议翻译成会话调用：

1. 收到客户端的 `tools` 定义 → 把工具名/说明/参数 Schema 写进提示词，
   并约定"需要工具时整个回复必须是一个 `{"tool_calls":[...]}` JSON"
2. 模型输出 JSON → 桥接解析 → 返回标准 `tool_calls` 给客户端
3. 客户端执行工具、把结果作为 `tool` 消息回传 → 桥接继续下一轮
4. 模型输出自然语言 → 作为最终答复返回

## 故障排查

- 运行日志：`bridge.log`（与 `bridge.mjs` 同目录）
- 健康检查：浏览器打开 `http://127.0.0.1:10000/health`，
  正常显示 `{"ok":true,"models":394}` 之类
- 模型"没有返回文字内容"：旧版本在模型中途调用 opencode 内置工具时会误报，
  当前版本会等待本轮真正结束（`finish=stop`）才取文字，并会在模型误用
  内置工具时自动纠正重试一次
- 端口被占：`stop.cmd` 会按端口 10000/10001 清理旧实例

## 文件清单

```
bridge.mjs                 桥接本体（OpenAI 兼容接口）
launch-backend.mjs         拉起 opencode 后端（显式注入密码/数据目录）
start.cmd / stop.cmd       一键启动 / 停止
config.local.example.json  配置模板（真实 config.local.json 不上传）
.opencode/agents/          桥接专用 agent 设定（运行必需）
test-pure.mjs              纯逻辑测试（24 项，不联网）
e2e-workbuddy.mjs          端到端：完整模拟客户端三轮工具任务
regress-basic.mjs          回归：聊天 + 图片理解
test-hijack-wait.mjs       回归：诱导内置工具场景
```

## License

MIT