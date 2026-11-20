#!/usr/bin/env node
// 超星学习通章节课程：原子操作命令行。
// 设计原则：每个子命令都短返回、输出一行 JSON，状态落盘，不依赖任何 agent 的常驻内核。
// 选择器全部集中在 SEL；页面改版时先用 `dom` 命令探查，再改这里或用 --sel 覆盖。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = process.env.CX_ENDPOINT || 'http://127.0.0.1:9222';
const STATE = process.env.CX_STATE || path.resolve('cx-state.json');

// ---- 选择器与框架匹配。均为"实测过的默认值"，不对就改，见 references/dom.md ----
export const SEL = {
  frameVideo: 'ananas/modules/video',
  frameWork: 'ananas/modules/work',
  frameGraded: 'selectWorkQuestionYiPiYue',
  frameTodo: 'doHomeWorkNew',
  frameCatalog: 'studentcourse',
  catalogItem: '.chapter_item',
  catalogDone: '.catalog_state.icon_yiwanc',
  inlineQuiz: '.ans-videoquiz',
  inlineOpt: '.ans-videoquiz-opt',
  inlineSubmit: '.ans-videoquiz-submit',
  question: '.TiMu',
  option: 'li[role=radio], li[role=checkbox]',
  // 对错标记有两套历史实现，跨版本并存：i.fr.dui 与 span.marking_dui
  markRight: '.fr.dui, .marking_dui, .dui',
  markWrong: '.fr.cuo, .marking_cuo, .cuo',
  myAnswer: '.Py_answer',
};

const out = (o) => { console.log(JSON.stringify(o)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, d) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : d; };
const flag = (name) => process.argv.includes('--' + name);

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sections: {} }; } };
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 1));
// 页面 URL 带 courseid/clazzid/enc/t 等会话令牌，打印前一律去掉 query，避免贴日志时外泄
const redact = (u) => {
  if (!u) return '';
  try { const x = new URL(u); return x.origin + x.pathname + (x.search ? '?…' : ''); } catch { return String(u).slice(0, 60); }
};

async function connect() {
  const browser = await puppeteer.connect({ browserURL: ENDPOINT, defaultViewport: null });
  const pages = await browser.pages();
  const want = arg('url-match', 'chaoxing.com');
  const page = pages.find((p) => p.url().includes(want) && p.url().includes('studentstudy'))
    || pages.find((p) => p.url().includes(want)) || pages[0];
  if (!page) throw new Error('no page in browser');
  return { browser, page };
}

const frameBy = (page, key) => page.frames().find((f) => f.url().includes(key));

// ---- 命令 ----
const cmds = {
  // 列出所有页面与框架，agent 用来判断所处位置
  async where({ page, browser }) {
    const tabs = (await browser.pages()).map((p) => redact(p.url()));
    out({ url: redact(page.url()), tabs, frames: page.frames().map((f) => redact(f.url())).filter((u) => u && u !== 'about:blank') });
  },

  // 导航：--url 绝对地址；不传则回到上一次记录的课程目录页（cx-state.json 里的 courseUrl）
  async goto({ page }) {
    const url = arg('url') || readState().courseUrl;
    if (!url) return out({ ok: false, err: 'no --url and no courseUrl in state' });
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { return out({ ok: false, err: String(e.message).slice(0, 120), url: redact(page.url()) }); }
    // 目录在 studentcourse 子框架里，等它出现，避免下一步读不到
    for (let i = 0; i < 20; i++) { if (page.frames().some((f) => f.url().includes(SEL.frameCatalog))) break; await sleep(500); }
    out({ ok: true, url: redact(page.url()), catalogFrame: page.frames().some((f) => f.url().includes(SEL.frameCatalog)) });
  },

  // 记住课程目录页，供 goto 使用
  async mark() {
    const st = readState(); st.courseUrl = arg('url') || arg('course', '');
    writeState(st); out({ ok: !!st.courseUrl, courseUrl: st.courseUrl });
  },

  // 课程目录：从目录页 iframe 读取小节与完成状态。必须在课程外壳页（含 studentcourse 框架）上运行。
  // 单元标题也是 .chapter_item，用 .catalog_state 区分：有任务点状态的是小节，没有的是单元。
  async outline({ page }) {
    const f = frameBy(page, SEL.frameCatalog);
    if (!f) return out({ ok: false, err: 'catalog frame not found; open the course chapter list first (see goto)', frames: page.frames().map((x) => redact(x.url())) });
    const items = await f.evaluate((S) => {
      const prog = (document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1, 3);
      const rows = [...document.querySelectorAll(S.catalogItem)];
      return { prog, rows: rows.map((r, i) => ({ i, name: (r.title || r.innerText || '').trim(), kind: r.querySelector('.catalog_state') ? 'section' : 'unit', done: !!r.querySelector(S.catalogDone) })) };
    }, SEL);
    const st = readState();
    st.outline = items.rows;
    writeState(st);
    const secs = items.rows.filter((r) => r.kind === 'section');
    out({ ok: true, sections: secs.length, units: items.rows.length - secs.length, done: secs.filter((r) => r.done).length, pending: secs.filter((r) => !r.done).map((r) => r.name), banner: items.prog });
  },

  // 点击目录项进入小节（按名字），并等待跳转到小节页
  async open({ page }) {
    const name = arg('name');
    const f = frameBy(page, SEL.frameCatalog);
    if (!f) return out({ ok: false, err: 'catalog frame not found; goto the course shell page first' });
    const hit = await f.evaluate((S, n) => {
      const nm = (e) => (e.title || e.innerText || '').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
      const r = [...document.querySelectorAll(S.catalogItem)].find((e) => nm(e) === n);
      if (!r) return 'not-found'; r.click(); return 'clicked';
    }, SEL, name);
    if (hit === 'clicked') {
      for (let i = 0; i < 20; i++) { if (page.url().includes('studentstudy')) break; await sleep(500); }
      // 小节页是异步渲染的，等标题出现再返回，否则下一步读不到内容
      for (let i = 0; i < 30; i++) {
        const t = await page.mainFrame().evaluate(() => (document.querySelector('.prev_title')?.innerText || '').trim()).catch(() => '');
        if (t) return out({ ok: true, name, title: t, url: redact(page.url()) });
        await sleep(500);
      }
    }
    if (hit === 'not-found') {
      const kind = await f.evaluate((S, n) => {
        const nm = (e) => (e.title || e.innerText || '').replace(/\s+/g, ' ').trim().split('\n')[0].trim();
        const r = [...document.querySelectorAll(S.catalogItem)].find((e) => nm(e) === n);
        return r ? (r.querySelector('.catalog_state') ? 'section' : 'unit') : null;
      }, SEL, name);
      return out({ ok: false, name, err: kind === 'unit' ? 'this is a chapter/unit heading, not a section; pass a section name' : 'name not found in catalog', kind });
    }
    out({ ok: true, name, url: redact(page.url()) });
  },

  // 当前小节标题与页签
  async section({ page }) {
    let d = null;
    for (let i = 0; i < 12; i++) {
      d = await page.mainFrame().evaluate(() => ({
        title: (document.querySelector('.prev_title')?.innerText || document.querySelector('.chapter_title')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        tabs: [...new Set([...document.querySelectorAll('li, div, a, span')].map((e) => e.innerText.trim()).filter((t) => /^\d*\s*(视频|测验)$/.test(t)))].slice(0, 6),
      })).catch(() => null);
      if (d && d.title) break;
      await sleep(500);
    }
    d ||= { title: '', tabs: [] };
    // "任务点已完成"横幅在子框架里
    let doneBanner = false;
    for (const f of page.frames()) { doneBanner = await f.evaluate(() => /任务点已完成|Task completed/i.test(document.body?.innerText || '')).catch(() => false); if (doneBanner) break; }
    out({ ok: true, ...d, doneBanner });
  },

  // 点击小节页签（按文本）：--to 视频|测验。点击后等待对应框架出现。
  async tab({ page }) {
    const want = arg('to', '测验');
    const hit = await page.mainFrame().evaluate((w) => {
      const els = [...document.querySelectorAll('li, div, a, span')].filter((e) => e.children.length <= 1 && new RegExp('^\\d*\\s*' + w + '$').test((e.innerText || '').trim()));
      if (!els.length) return false; els[0].click(); return true;
    }, want);
    if (!hit) return out({ ok: false, err: 'tab not found', to: want });
    const key = want === '测验' ? [SEL.frameTodo, SEL.frameGraded] : [SEL.frameVideo];
    for (let i = 0; i < 24; i++) { if (page.frames().some((f) => key.some((k) => f.url().includes(k)))) break; await sleep(500); }
    out({ ok: true, to: want, frameReady: page.frames().some((f) => key.some((k) => f.url().includes(k))) });
  },

  // 读待答测验：返回题号、题干、选项文本、题型；不会提交
  async quiz({ page }) {
    let t = frameBy(page, SEL.frameTodo) || frameBy(page, SEL.frameGraded);
    for (let i = 0; i < 20 && !t; i++) { await sleep(500); t = frameBy(page, SEL.frameTodo) || frameBy(page, SEL.frameGraded) || frameBy(page, SEL.frameWork); }
    if (!t) return out({ ok: false, err: 'no quiz frame; click the quiz tab first (tab --to 测验', frames: page.frames().map((x) => redact(x.url())).filter(Boolean) });
    const qs = await t.evaluate((S) => [...document.querySelectorAll(S.question)].map((q, i) => ({
      i, text: (q.querySelector('.qtContent')?.innerText || q.innerText).replace(/\s+/g, ' ').trim().slice(0, 300),
      opts: [...q.querySelectorAll('li')].map((l) => l.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
      multi: !!q.querySelector('li[role=checkbox]') || /Multiple|多选/.test(q.innerText),
      graded: !!(q.querySelector(S.markRight) || q.querySelector(S.markWrong)),
      mark: q.querySelector(S.markRight) ? 'right' : q.querySelector(S.markWrong) ? 'wrong' : null,
      mine: (q.querySelector(S.myAnswer)?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    })), SEL);
    out({ ok: true, frame: t.url().includes(SEL.frameGraded) ? 'graded' : 'todo', n: qs.length, qs });
  },

  // 视频探针（切页签后视频框架会重建，等一会儿）
  async probe({ page }) {
    let f = frameBy(page, SEL.frameVideo);
    for (let i = 0; i < 12 && !f; i++) { await sleep(500); f = frameBy(page, SEL.frameVideo); }
    if (!f) return out({ frame: false });
    const s = await f.evaluate((S) => {
      const v = document.querySelector('video'); const q = document.querySelector(S.inlineQuiz);
      const vis = (e) => e && e.offsetParent !== null;
      return { t: v?.currentTime, d: v?.duration, p: v?.paused, ended: v?.ended, ready: v?.readyState, rate: v?.playbackRate, quiz: q && vis(q) ? q.innerText.replace(/\s+/g, ' ').slice(0, 400) : null };
    }, SEL);
    out({ frame: true, ...s, t: s.t != null ? +s.t.toFixed(1) : null, d: s.d != null ? +s.d.toFixed(1) : null });
  },

  // 播放（保持 1 倍速，不改 playbackRate）
  async play({ page }) {
    let f = frameBy(page, SEL.frameVideo);
    for (let i = 0; i < 12 && !f; i++) { await sleep(500); f = frameBy(page, SEL.frameVideo); }
    if (!f) return out({ ok: false, err: 'no video frame' });
    const r = await f.evaluate(() => { const v = document.querySelector('video'); if (!v) return 'no video'; if (v.paused) { v.play().catch(() => {}); return 'play called'; } return 'already playing'; });
    out({ ok: true, r });
  },

  // 观看：每 --every 秒探测一次，共 --checks 次；遇弹题/结束/暂停异常就返回。总时长不要超过 agent 的工具超时。
  async watch({ page }) {
    const every = +arg('every', 30), checks = +arg('checks', 4);
    const f0 = frameBy(page, SEL.frameVideo);
    if (!f0) return out({ reason: 'no-frame' });
    let last = null, stall = 0; const log = [];
    for (let i = 0; i < checks; i++) {
      await sleep(every * 1000);
      const f = frameBy(page, SEL.frameVideo); if (!f) return out({ reason: 'frame-lost', log });
      const s = await f.evaluate((S) => { const v = document.querySelector('video'); const q = document.querySelector(S.inlineQuiz); const vis = (e) => e && e.offsetParent !== null;
        return { t: v?.currentTime, d: v?.duration, p: v?.paused, ended: v?.ended, ready: v?.readyState, quiz: q && vis(q) ? q.innerText.replace(/\s+/g, ' ').slice(0, 400) : null }; }, SEL);
      log.push({ t: s.t != null ? +s.t.toFixed(1) : null, p: s.p });
      if (s.quiz) return out({ reason: 'quiz', quiz: s.quiz, t: s.t, d: s.d, log });
      if (s.ended || (s.d && s.t >= s.d - 1)) return out({ reason: 'ended', t: s.t, d: s.d, log });
      if (s.p) { await f.evaluate(() => document.querySelector('video')?.play().catch(() => {})); }
      if (last != null && s.t != null && Math.abs(s.t - last) < 1 && !s.p) { if (++stall >= 2) return out({ reason: 'stall', t: s.t, d: s.d, log }); } else stall = 0;
      last = s.t;
    }
    out({ reason: 'continue', log });
  },

  // 视频内嵌题：--pick 0,2 选第几个选项（0 起），自动提交。判断题/单选/多选均适用。
  async inline({ page }) {
    const pick = (arg('pick', '0') || '').split(',').map(Number);
    const f = frameBy(page, SEL.frameVideo);
    if (!f) return out({ ok: false, err: 'no video frame' });
    const r = await f.evaluate((S, want) => {
      const opts = [...document.querySelectorAll(S.inlineOpt)];
      if (!opts.length) return { ok: false, err: 'no options' };
      opts.forEach((o, i) => { const inp = o.querySelector('input'); const w = want.includes(i); if (inp && inp.checked !== w) (o.querySelector('label') || o).click(); });
      const now = opts.map((o) => !!o.querySelector('input')?.checked);
      document.querySelector(S.inlineSubmit)?.click();
      return { ok: true, n: opts.length, now };
    }, SEL, pick);
    out(r);
  },


  // 作答测验：--spec '{"0":[2],"1":[0,1]}'，题号 -> 选项下标。只勾选，不提交。判断题第 0 项为"对/True"。
  async answer({ page }) {
    const spec = JSON.parse(arg('spec', '{}'));
    const t = frameBy(page, SEL.frameTodo);
    if (!t) return out({ ok: false, err: 'todo frame not found (maybe already graded?)' });
    const r = await t.evaluate((S, sp) => {
      const qs = [...document.querySelectorAll(S.question)]; const res = [];
      for (const [qi, idxs] of Object.entries(sp)) {
        const q = qs[+qi]; if (!q) { res.push({ q: +qi, err: 'no such question' }); continue; }
        const lis = [...q.querySelectorAll(S.option)];
        // 先清空再勾选，保证结果等于 spec
        lis.forEach((l, k) => { const inp = l.querySelector('input'); if (inp?.checked && !idxs.includes(k)) (l.querySelector('label') || l).click(); });
        lis.forEach((l, k) => { const inp = l.querySelector('input'); if (idxs.includes(k) && !inp?.checked) (l.querySelector('label') || l).click(); });
        res.push({ q: +qi, checked: lis.map((l) => !!l.querySelector('input')?.checked) });
      }
      return res;
    }, SEL, spec);
    out({ ok: true, r });
  },

  // 提交测验并确认弹窗
  async submit({ page }) {
    const t = frameBy(page, SEL.frameTodo);
    if (!t) return out({ ok: false, err: 'todo frame not found' });
    const ok1 = await t.evaluate(() => { const b = [...document.querySelectorAll('a,button')].find((x) => /^(Submit|提交)$/i.test((x.innerText || '').trim())); if (!b) return false; b.click(); return true; });
    if (!ok1) return out({ ok: false, err: 'no submit button' });
    await sleep(2500);
    const ok2 = await page.evaluate(() => { const c = [...document.querySelectorAll('a,button,span')].find((x) => x.offsetParent && /^(OK|确定|确认)$/i.test((x.innerText || '').trim()) && !x.children.length); if (c) { c.click(); return true; } return false; })
      .catch(() => false);
    const ok3 = ok2 || await (frameBy(page, SEL.frameTodo)?.evaluate(() => { const c = [...document.querySelectorAll('a,button,span')].find((x) => x.offsetParent && /^(OK|确定|确认)$/i.test((x.innerText || '').trim()) && !x.children.length); if (c) { c.click(); return true; } return false; }).catch(() => false));
    out({ ok: true, confirmed: !!ok3 });
  },

  // 读批改结果：每题对错与得分、我的答案。页面不给标准答案，答案是否正确只能由对/错标记和得分判断。
  async score({ page }) {
    let t = frameBy(page, SEL.frameGraded);
    for (let i = 0; i < 24 && !t; i++) { await sleep(500); t = frameBy(page, SEL.frameGraded); }
    if (!t) return out({ ok: false, err: 'graded frame not found; wait a few seconds after submit, or reopen the quiz tab' });
    const qs = await t.evaluate((S) => [...document.querySelectorAll(S.question)].map((q, i) => ({
      i, mark: q.querySelector(S.markRight) ? 'right' : q.querySelector(S.markWrong) ? 'wrong' : 'unknown',
      mine: (q.querySelector(S.myAnswer)?.innerText || q.querySelector('.newAnswerBx')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      score: ((q.innerText.match(/(\d+(?:\.\d+)?)\s*score|(\d+(?:\.\d+)?)\s*分/) || []))[1] || ((q.innerText.match(/(\d+(?:\.\d+)?)\s*score|(\d+(?:\.\d+)?)\s*分/) || []))[2] || null,
    })), SEL);
    const total = qs.reduce((a, q) => a + (+q.score || 0), 0);
    out({ ok: true, n: qs.length, total: +total.toFixed(1), allRight: qs.every((q) => q.mark === 'right'), qs });
  },

  // 核验：读目录页的完成状态。--name 指定小节名；不带则返回总览。必须在课程外壳页上运行。
  async verify({ page }) {
    const name = arg('name');
    const f = frameBy(page, SEL.frameCatalog);
    if (!f) return out({ ok: false, err: 'catalog frame not found; goto the course shell page first (verify must run there, not on a section page)' });
    const rows = await f.evaluate((S) => [...document.querySelectorAll(S.catalogItem)].map((r) => ({ name: (r.title || '').trim(), kind: r.querySelector('.catalog_state') ? 'section' : 'unit', done: !!r.querySelector(S.catalogDone) })), SEL);
    const secs = rows.filter((r) => r.kind === 'section');
    if (name) { const r = secs.find((x) => x.name === name); return out({ ok: !!r, name, done: !!r?.done }); }
    out({ ok: true, sections: secs.length, done: secs.filter((r) => r.done).length, pending: secs.filter((r) => !r.done).map((r) => r.name) });
  },

  // DOM 探查：页面改版时用。--frame 过滤框架 URL 子串，--grep 过滤 class 名
  async dom({ page }) {
    const key = arg('frame', ''); const g = new RegExp(arg('grep', '.'), 'i');
    const res = [];
    for (const f of page.frames()) {
      if (key && !f.url().includes(key)) continue;
      const d = await f.evaluate((gs) => { const re = new RegExp(gs, 'i'); const c = {}; for (const e of document.querySelectorAll('[class]')) for (const k of e.classList) if (re.test(k)) c[k] = (c[k] || 0) + 1; return { classes: c, text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 200) }; }, g.source).catch(() => null);
      if (d && (Object.keys(d.classes).length || d.text)) res.push({ url: redact(f.url()), ...d });
    }
    out({ frames: res });
  },

  // 截图：--path 输出；--full 整页
  async shot({ page }) {
    const p = arg('path', path.resolve('cx-shot.png'));
    await page.screenshot({ path: p, fullPage: flag('full') });
    out({ ok: true, path: p });
  },

  // 记录小节结果到状态文件（断点续跑 + 汇总用）
  async record() {
    const name = arg('name'); const st = readState();
    st.sections ||= {};
    const prev = st.sections[name] || {};
    st.sections[name] = { ...prev, ...JSON.parse(arg('data', '{}')), at: new Date().toISOString() };
    writeState(st);
    out({ ok: true, name, sections: Object.keys(st.sections).length });
  },

  // 汇总：已完成 / 存疑 / 待处理
  async summary() {
    const st = readState(); const s = st.sections || {};
    const names = Object.keys(s);
    const secs = (st.outline || []).filter((r) => r.kind === 'section');
    out({
      recorded: names.length,
      verified: names.filter((n) => s[n].verified).length,
      doubtful: names.filter((n) => (s[n].doubtful || []).length).map((n) => ({ name: n, items: s[n].doubtful })),
      unverified: names.filter((n) => !s[n].verified),
      catalogPending: secs.filter((r) => !r.done && !s[r.name]?.verified).map((r) => r.name),
    });
  },
};

const sub = process.argv[2];
if (!sub || !cmds[sub]) { console.error('usage: cx.mjs <' + Object.keys(cmds).join('|') + '> [--opt v]'); process.exit(2); }
if (sub === 'record' || sub === 'summary' || sub === 'mark') { await cmds[sub](); process.exit(0); }
let ctx, code = 0;
try { ctx = await connect(); await cmds[sub](ctx); }
catch (e) { out({ ok: false, err: String(e.message || e).slice(0, 300) }); code = 1; }
finally { try { await ctx?.browser.disconnect(); } catch {} }
// 经转发代理时残留 socket 会让进程多挂约 30 秒；输出已写完，直接退出。
process.stdout.write('', () => process.exit(code));
