import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'ai-daily-digest-plugin.zip');

rmSync(out, { force: true });

execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${path.join(here, 'manifest.json')}','${path.join(here, 'plugin.js')}' -DestinationPath '${out}' -Force`,
  ],
  { stdio: 'inherit' },
);

if (!existsSync(out)) throw new Error('打包失败：未生成 zip');
console.log(`\n已生成 ${out}`);
console.log('应用内安装：设置 → 插件 → 上传插件 ZIP，选中该文件后启用。');
