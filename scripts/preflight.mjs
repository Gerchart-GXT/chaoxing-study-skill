#!/usr/bin/env node
// 环境自检：逐项给出 PASS / FAIL 与修复提示。任何一项 FAIL 都不要继续刷课。
// 用法：node preflight.mjs [--endpoint http://127.0.0.1:9222] [--login]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const endpoint = arg('endpoint', process.env.CX_ENDPOINT || 'http://127.0.0.1:9222');
const results = [];
const rec = (name, ok, detail, fix) => { results.push({ name, ok, detail, fix: ok ? undefined : fix }); };

const isWSL = /microsoft/i.test(os.release());
const platform = isWSL ? 'wsl' : process.platform;
// 课程页 URL 带 courseid/clazzid/enc/t，打印前去掉 query，避免贴日志时外泄
const redact = (u) => { try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?…' : ''); } catch { return String(u || '').slice(0, 60); } };

// 1. Node
const major = +process.versions.node.split('.')[0];
rec('node>=18', major >= 18, process.version, '安装 Node 18+ 或 Bun');

// 2. 依赖
let hasPup = false;
try { await import('puppeteer-core'); hasPup = true; } catch {}
rec('puppeteer-core', hasPup, hasPup ? 'installed' : 'missing', `在 ${here} 执行 npm install`);

// 3. 浏览器可执行文件
const candidates = {
  wsl: ['/mnt/c/Program Files/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
}[platform] || [];
const browserPath = candidates.find((p) => fs.existsSync(p));
rec('browser-binary', !!browserPath, browserPath || 'not found', '安装 Chrome / Edge / Chromium（需有图形界面，让你能看到窗口）');

// 4. 图形界面（无头环境提示）
const hasDisplay = platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
rec('visible-display', hasDisplay, hasDisplay ? 'ok' : 'no DISPLAY', '本流程要求窗口对用户可见；无图形界面时需虚拟显示并让用户能查看，或改在有桌面的机器上运行');

// 5. 调试端口
let ver = null;
try { const r = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(4000) }); ver = await r.json(); } catch {}
const launchHint = {
  wsl: `1) 启动：nohup "${browserPath || '<chrome.exe>'}" --remote-debugging-port=9222 --user-data-dir='C:\\Temp\\cx-chrome' --no-first-run "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com" &  2) WSL2 是 NAT：Windows 的 127.0.0.1:9222 在 WSL 内不可达，需在 Windows 端做 TCP 转发到网关 IP（ip route | awk '/default/{print $3}'），再把 --endpoint 指向 http://<网关IP>:<转发端口>。见 references/environment.md`,
  linux: `启动：${browserPath || 'google-chrome'} --remote-debugging-port=9222 --user-data-dir=$HOME/.cx-chrome --no-first-run "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com" &`,
  darwin: `启动：open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=$HOME/.cx-chrome "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com"`,
  win32: `启动：& "${browserPath || 'chrome.exe'}" --remote-debugging-port=9222 --user-data-dir=$env:TEMP\\cx-chrome "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com"`,
}[platform];
rec('debug-port', !!ver, ver ? ver.Browser : `${endpoint} 无响应`, launchHint);

// 6. 页面与登录态
let cxPage = null, loggedIn = false;
if (ver && hasPup) {
  try {
    const puppeteer = (await import('puppeteer-core')).default;
    const b = await puppeteer.connect({ browserURL: endpoint, defaultViewport: null });
    const pages = await b.pages();
    cxPage = pages.find((p) => p.url().includes('chaoxing.com')) || null;
    if (cxPage) {
      const url = cxPage.url();
      loggedIn = !/passport2\.chaoxing\.com\/login|\/login\?/i.test(url);
      if (loggedIn) {
        const cookies = await cxPage.cookies('https://chaoxing.com').catch(() => []);
        loggedIn = cookies.some((c) => /^(UID|_uid|uf|_d)$/.test(c.name));
      }
    }
    await b.disconnect();
  } catch (e) { rec('cdp-attach', false, String(e.message).slice(0, 120), 'Chrome 重启后需重新附着；若报 404，说明 ws id 已变，重新取 /json/version'); }
  rec('chaoxing-tab', !!cxPage, cxPage ? redact(cxPage.url()) : '没有超星标签页', '在该浏览器里打开 https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com');
  rec('logged-in', loggedIn, loggedIn ? 'ok' : '未登录', '请用户在浏览器窗口里扫码或账号登录，完成后重新自检。不要索要或输入账号密码');
}

// 7. 视觉能力（无法自动检测，只提示）
rec('vision-model', true, 'manual', '无法从脚本检测。题干/选项含图片或公式时需要多模态模型，若当前模型不支持，遇到此类题只能标记存疑，不能猜');

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ platform, endpoint, pass: failed.length === 0, failed: failed.map((r) => r.name), results }, null, 1));
process.stdout.write('', () => process.exit(failed.length ? 1 : 0));
