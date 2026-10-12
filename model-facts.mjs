// 拉取 opencode 目录里 4 个免费模型的真实属性
import { OpenCode } from '@opencode/client';

const BACKEND = 'http://127.0.0.1:10001';
const password = process.env.OPENCODE_SERVER_PASSWORD || '';
const auth = { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64') };
const raw = OpenCode.make({ baseUrl: BACKEND });

const want = [
  'longcat-2.5-preview-free',
  'step-5-preview-free',
  'mimo-v2.6-flash-free',
  'big-pickle',
];

const res = await raw.model.list(undefined, { headers: auth });
const all = res.data || [];
for (const id of want) {
  const m = all.find((x) => x.providerID === 'opencode' && x.id === id);
  if (!m) { console.log(`\n### ${id}: 未找到`); continue; }
  console.log(`\n### ${id}`);
  console.log(JSON.stringify({
    name: m.name,
    capabilities: m.capabilities,
    limit: m.limit,
    cost: m.cost,
    reasoning: m.reasoning,
    variants: m.variants,
    family: m.family,
  }, null, 1));
}
