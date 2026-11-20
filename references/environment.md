# 环境与安装

目标：任何具备 bash 与文件读写的 agent，都能按本文把环境装好并自检通过。全程不需要 omp 专有能力。

## 1. 组件

| 组件 | 要求 | 说明 |
|---|---|---|
| Node | ≥ 18 | 脚本是 ESM，用 `node` 执行。Bun 也可 |
| 可见 Chromium 系浏览器 | Chrome / Edge / Chromium | 必须有图形界面：登录要用户扫码，过程也要让用户能看见 |
| `puppeteer-core` | 装在 `scripts/` 下 | 只连 CDP，不下载浏览器 |
| 一个可用的推理模型 | —— | 读题、判题型、决定选项 |
| 多模态模型 | 可选 | 题干或选项含图/公式时才需要 |

装依赖：

```bash
cd scripts && npm install
```

## 2. 启动浏览器

关键点：`--remote-debugging-port` 是唯一入口，agent 通过 CDP 接管，不自己起无头浏览器。用独立 `--user-data-dir`，不动用户日常配置。

Linux / macOS：

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.cx-chrome" --no-first-run \
  "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com"
```

Windows PowerShell：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\cx-chrome" --no-first-run `
  "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com"
```

WSL2：

```bash
nohup "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --remote-debugging-port=9222 --user-data-dir='C:\Temp\cx-chrome' --no-first-run \
  "https://passport2.chaoxing.com/login?fid=&newversion=true&refer=https%3A%2F%2Fi.chaoxing.com" >/dev/null 2>&1 &
```

WSL2 是 NAT 网络，Windows 的 `127.0.0.1:9222` 在 WSL 内不可达，必须转发。在 Windows 端跑一个 TCP 转发，监听 WSL 网关地址：

```powershell
$gw = (Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway}).IPv4Address.IPAddress
$l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($gw), 9223)
$l.Start()
while ($true) {
  $c = $l.AcceptTcpClient()
  $r = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 9222)
  $cs = $c.GetStream(); $rs = $r.GetStream()
  $null = $cs.CopyToAsync($rs); $null = $rs.CopyToAsync($cs)
}
```

WSL 内取网关：`ip route | awk '/default/{print $3}'`。之后统一用：

```bash
export CX_ENDPOINT=http://<网关IP>:9223
```

验证：`curl $CX_ENDPOINT/json/version` 必须返回 `webSocketDebuggerUrl`。

## 3. 登录

1. 让用户在浏览器窗口里自己完成登录（扫码或账号密码）。
2. **不要**索要或代填账号密码。
3. 登录成功判据：页面离开 `passport2.chaoxing.com/login`，且能进 `i.chaoxing.com`。

本 Skill 从超星官网入口登录，不依赖任何学校门户。用户账号通常是个人超星账号；能否看到某门课取决于该账号是否已被学校绑进课程，属于运行时事实，脚本不判断。

## 4. 自检

```bash
node scripts/preflight.mjs                     # 本机直连
node scripts/preflight.mjs --endpoint $CX_ENDPOINT   # WSL 经转发
```

输出 `pass: true` 才能继续。逐项含义：

| 检查项 | 失败时的处理 |
|---|---|
| `node>=18` | 装 Node 18+ |
| `puppeteer-core` | `cd scripts && npm install` |
| `browser-binary` | 装 Chrome/Edge/Chromium |
| `visible-display` | 需要图形界面；无头环境不适合本流程 |
| `debug-port` | 没起浏览器或端口没开；WSL 下检查转发 |
| `chaoxing-tab` | 浏览器里没有超星页面 |
| `logged-in` | 让用户登录 |
| `vision-model` | 人工确认；不支持时含图题只能记存疑 |

## 5. 收尾

任务结束后：关闭该 Chrome 实例，停掉转发进程，删除独立 user-data-dir（含登录态）。

## 6. 状态文件

`cx-state.json`（默认在 cwd，可用 `CX_STATE` 指定）保存：课程外壳页 URL、目录快照、每小节结果。它是断点续跑的唯一依据，丢失不影响页面，只是要重新 `outline` 一次。

**不要把 `cx-state.json` 提交到任何仓库**：里面有带令牌的课程 URL。
