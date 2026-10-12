/**
 * launch-backend.mjs — 用显式环境变量启动 opencode 后端（10001）
 *
 * 为什么不放在 start.cmd 里用 set：批处理的环境变量传递在部分启动链下不可靠，
 * 导致后端和桥接拿到不同密码。这里用 Node spawn 显式传 env，完全确定。
 * 数据目录隔离（XDG_DATA_HOME）：桥接的会话存独立库，不再污染 OpenChamber 的会话列表。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'config.local.json'), 'utf8'));

// 子进程环境：显式注入密码和数据目录，并剥离 OpenChamber 注入的变量
// （OPENCODE_CONFIG 会加载 OpenChamber 的插件，那个插件会把服务器密码
//   覆盖成 OpenChamber 的轮换值；OPENCODE_PASSWORD 同理会造成干扰）
const childEnv = {
  ...process.env,
  OPENCODE_SERVER_PASSWORD: cfg.backendPassword, // 显式注入，不信赖继承
  XDG_DATA_HOME: cfg.xdgDataHome, // 独立数据目录 → 独立数据库
};
for (const k of ['OPENCODE_CONFIG', 'OPENCODE_PASSWORD', 'OPENCODE_TERMINAL', 'OPENCODE', 'OPENCODE_SESSION_ID', 'OPENCODE_ENABLE_PARALLEL', 'OPENCODE_CLI_CONFIG_CONTENT']) {
  delete childEnv[k];
}

const child = spawn(
  cfg.opencodePath,
  ['serve', '--hostname', '127.0.0.1', '--port', String(cfg.backendPort)],
  {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  }
);
child.unref();
console.log(`[backend] 已启动 pid=${child.pid} port=${cfg.backendPort} 数据目录=${cfg.xdgDataHome}`);
