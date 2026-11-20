# 排错

每条都是实测踩到的，按现象查。

## 1. 所有命令固定慢 30 秒

现象：命令能出正确结果，但进程挂 30 秒才退出（`where`/`section`/`probe` 都是 30.3s）。

原因：经 TCP 转发连 CDP 时，残留 socket 让 Node 事件循环不退出，不是页面慢。

处理：`cx.mjs` 结尾已用 `process.stdout.write('', () => process.exit(code))`，输出写完立即退出。若你自己写脚本，照做；`browser.close()` 也解决不了这个问题。

## 2. `No page targets available` / WebSocket 404

现象：`browser.targets()` 能列出页面，`browser.open()` 报没有页面目标；或报 `ws://…/devtools/browser/<旧id> 404`。

原因：Chrome 重启后 browser 级 ws id 变了，agent 侧缓存了旧连接。

处理：

1. `curl $CX_ENDPOINT/json/version` 取当前 `webSocketDebuggerUrl` 的 id。
2. 关掉旧会话（`browser.close({all:true})`），必要时重启 agent 的 JS 内核。
3. 重新接管。

`puppeteer.connect({browserURL})` 每次都重新读 `/json/version`，不受此影响，这也是本 Skill 用 puppeteer 而不是自己管 ws 的原因。

## 3. 「无效的参数」

现象：外壳页只剩一个插画和「无效的参数」，没有子框架。

原因：URL 里的 `t` 参数被改动。它不是缓存时间戳，改成当前毫秒会直接失败。

处理：用捕获到的原 URL。见 `dom.md`「课程外壳页的 URL 不可拼装」。

## 4. `catalog frame not found`

| 场景 | 原因 | 处理 |
|---|---|---|
| 在小节页执行 `outline`/`verify` | 目录在外壳页的 `studentcourse` 框架里，小节页没有 | `cx.mjs goto` 回外壳页 |
| 外壳页已加载但框架未生成 | 页面还在渲染 | `goto` 内部最多等 10 秒；仍失败就 `where` 看框架列表 |
| 进了「无效的参数」页 | 见第 3 条 | 换回原 URL |

## 5. 页签点了没反应

- 页签在历史上是 `li` 也可能是 `div`，按标签名选会失败。`tab` 已改为按文本匹配（`^视频$` / `^测验$`）。
- 点击后作业框架是异步加载的，`tab` 会最多等 12 秒并返回 `frameReady`。`frameReady: false` 说明没加载出来，重试一次或刷新页面。
- 同一小节里「测验」页签可能出现两次（外壳 + 内层），点第一个即可。

## 6. `quiz` 读到的是批改结果而不是待答

- 打开 `selectWorkQuestionYiPiYue` 说明该测验**已提交过**，平台不会再给答题目。
- `quiz` 返回值里 `frame: "graded"` 且每题带 `mark`/`mine`，就是这个情况。
- 想重做需平台允许（"重做"入口），且会覆盖已有成绩，**未经用户明确同意不要点**。

## 7. 对错标记全部 `unknown`

批改页有两套标记：`i.fr.dui` / `span.marking_dui`。只看一套会全判 unknown。`SEL.markRight`/`markWrong` 已用交集。

如果两套都读不到，`dom --frame selectWorkQuestion --grep 'dui|cuo|mark'` 现场探。

## 8. 视频 `d`/`t` 是 `null`

视频未加载时 `duration` 是 `NaN`（JSON 里成了 `null`）、`readyState` 是 0。这是正常态，不是错误。等播放开始后再探。

## 9. 播放不动（stall）

`watch` 连续两次探测时间几乎不变且未暂停，返回 `reason=stall`。

处理：刷新页面 → 重新进入该小节 → 重新播放。缓冲卡死靠等待不会恢复。

## 10. 工具调用超时

一次 `watch` 不要超过 agent 的工具超时。默认设计：`--every 30 --checks 4`（约 2 分钟）。宁可多次短调用，也不要一次长等待。

Claude Code 这类工具超时较紧的 agent，用 `--every 15 --checks 4`。

## 11. 状态文件丢失

`cx-state.json` 丢了不影响页面进度，只是断点信息消失：重新 `outline`，再按目录顺序继续即可。

## 12. 目录里出现「承诺书」这类无任务点条目

`.chapter_item` 里混着真小节、章单元标题、以及「承诺书」之类的非任务条目。`outline` 用 `.catalog_state` 区分，只把真小节计入进度。若出现 `kind: "unit"` 的项，直接跳过。

## 13. 隐私

- 外壳页 URL 含 `cpi`、`enc`、`t` 等令牌，等同会话凭据。不要写进 Skill、笔记、提交记录。
- 笔记与汇报只写课程结构（章节名、题目、答案），不写学校名、单位名、课程 id。
- `where`/`goto`/`dom`/`preflight` 的 URL 输出已去掉 query（显示为 `?…`），可以安全贴日志；`mark` 会回显你传入的完整 URL，那条不要外贴。
- `dom` 除了类名统计，还会带回当前页面 **200 字文本片段**（可能含课程名、教师名、章节名）。贴 `dom` 结果前自己看一眼，或用 `--grep` 收窄。
