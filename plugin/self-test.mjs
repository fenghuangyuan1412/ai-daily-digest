import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const code = readFileSync(path.join(here, 'plugin.js'), 'utf8');
// 默认测已提交的 digest/latest.json；也可传路径单独验一份带译文的产物
const digestPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, '..', 'digest', 'latest.json');
const digest = JSON.parse(readFileSync(digestPath, 'utf8'));

const mkStub = (input) => {
  const api = {
    calls: { addTask: [], persist: [], snack: [] },
    _ready: null,
    cfg: {},
    Hooks: {},
    log: { warn: () => {}, info: () => {}, err: () => {} },
    request: input.request || (async () => input.response),
    loadSyncedData: async () => input.stored,
    persistDataSynced: async (s, k) => api.calls.persist.push([s, k]),
    getAllTags: async () => [{ id: 't1', label: 'AI日报' }],
    addTag: async () => 't-new',
    addTask: async (t) => {
      api.calls.addTask.push(t);
      return 'task-' + api.calls.addTask.length;
    },
    showSnack: (c) => api.calls.snack.push(c),
    onReady: (fn) => { api._ready = fn; },
    onUnload: () => {},
  };
  return api;
};

const run = async (name, input) => {
  const api = mkStub(input);
  new Function('PluginAPI', code)(api);
  await api._ready();
  await new Promise((r) => setTimeout(r, 30));
  console.log(`\n[${name}]`);
  console.log('  addTask 调用次数:', api.calls.addTask.length);
  const t = api.calls.addTask[0];
  if (t) {
    console.log('  标题:', t.title);
    console.log('  projectId:', t.projectId, '| tagIds:', JSON.stringify(t.tagIds), '| dueDay:', t.dueDay);
    console.log('  notes 长度:', t.notes.length, '字符');
    console.log('  notes 首尾:', JSON.stringify(t.notes.slice(0, 40)), '...', JSON.stringify(t.notes.slice(-46)));
    console.log('  含 - [ ] 触发清单模式:', /- \[[ x]\]/.test(t.notes));
    console.log('  含未还原占位符:', /Zz\d+zZ/.test(t.notes));
    console.log('  snack:', JSON.stringify(api.calls.snack));
  }
  clearInterval(0);
  return api;
};

let uncaught = 0;
process.on('unhandledRejection', (e) => { uncaught += 1; console.log('  ✗ 未捕获异常:', e.message); });

// 1) 首次安装：本地无记录 -> 应投一条
const a = await run('首次运行', { response: digest, stored: null });
console.log('  写入的同步状态:', a.calls.persist.map((p) => p[0]).join(''));

// 2) 当天重复打开：已记录同一天 -> 不应重复投
await run('同一天重复打开', { response: digest, stored: JSON.stringify({ lastDate: digest.date }) });

// 3) 网络失败：应静默跳过，不产生未捕获异常
await run('拉取失败', { request: () => Promise.reject(new Error('network down')), stored: null });

console.log(`\n结论：未捕获异常 ${uncaught} 次（期望 0）`);
process.exit(0);
