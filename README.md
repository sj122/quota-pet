<div align="center">

# 额度桌宠 QuotaPet

**Linux 环境分支 · 默认奶龙 · 兼容 Codex 官方宠物格式。**

让奶龙陪你盯着额度。点一下，查看 Codex / Claude 订阅用量，以及 DeepSeek 余额与消费趋势；也可以拖动、甩出、摸摸它。

![Linux](https://img.shields.io/badge/Linux-X11%20%2F%20XWayland-FCC624?logo=linux&logoColor=black)
![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?logo=windows&logoColor=white)
![Codex Pets](https://img.shields.io/badge/Codex%20Pets-v1%20%2F%20v2-F1C75B)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

<img src="docs/linux-nailong.png" alt="Linux 默认奶龙与三家服务的真实应用面板截图，使用演示数据" width="1040" />

</div>

## 能看什么

| 服务 | 显示内容 |
|---|---|
| **Codex** | 5 小时与每周额度、剩余百分比、重置时间、套餐、可用额度重置卡及每张卡的到期时间 |
| **Claude** | 5 小时与每周额度；使用 Claude Code 登录凭据时，可显示接口返回的 Opus / Sonnet 周额度和精确重置时间 |
| **DeepSeek** | 账户余额、充值与赠金明细、今日 / 本月消费估算、近 7 天消费趋势 |

- **默认奶龙**：仓库自带奶龙动画，首次启动直接显示，无需额外下载宠物；仍可在右键菜单切换自己的宠物。
- **Linux 桌面交互**：使用固定透明画布，宠物在画布内移动；X11 输入区域只覆盖宠物和气泡，拖动和弹跳不反复移动原生窗口。
- **复用 Codex 宠物**：直接读取本机已安装的 Codex 自定义宠物，兼容官方 v1 / v2 精灵图格式，支持透明 PNG / WebP。
- **Codex 令牌直查**：优先使用本机登录令牌查询，正常刷新不启动 `codex.exe`，无需额外填写 OpenAI API Key。
- **桌面交互**：单击查看额度、拖动移动位置、悬停显示摘要；透明区域可穿透鼠标，v2 宠物支持眼睛跟随鼠标。
- **用量提醒**：订阅额度或余额低于设定值时，猫猫会做出提醒动作并弹出气泡；额度窗口重置时会蹦起来庆祝“额度回满啦”。
- **陪伴互动**：快速甩开它会飞出去，碰到屏幕边会弹，半空中按住能接住；在它身上来回蹭会冒爱心；闲着时沿任务栏走几步、看场合说句话；离开电脑会睡觉，回来汇报离开期间的额度变化。
- **头顶小图标**：💦 额度紧张、💤 睡着了、❗ 全部读取失败，不用悬停也能一眼看到状态。
- **日常使用**：支持浅色 / 深色 / 跟随系统、托盘菜单、宠物大小调整和开机自启（Windows）。

<div align="center">
<img src="docs/nailong-actions.png" alt="奶龙的待机、走路、捂肚大笑、思考和敲代码动作" width="1040" />
</div>

> 展示图使用本分支默认的奶龙，额度与余额来自 `test/demo-data.js` 的演示数据。奶龙素材来自 [Tomorins/nailong-codex-pet](https://github.com/Tomorins/nailong-codex-pet)，来源与权利说明见 [NOTICE](assets/pets/nailong/NOTICE.md)。

## 快速开始

需要 **Windows 10 / 11 或 Linux 桌面**和 **Node.js 22.12+**。Linux 需要 Python 3、X11、libX11 和 libXext；Wayland 会话需要安装并启用 XWayland。

```bash
git clone --branch "linux环境" --single-branch https://github.com/sj122/quota-pet.git
cd quota-pet
npm install
npm start
```

首次启动时，默认奶龙会出现在桌面右下角，托盘里也会多一个图标。已有配置中手动选择的宠物会保留。

Ubuntu / Debian 桌面可先安装 Linux 输入辅助程序需要的系统依赖：

```bash
sudo apt install python3 libx11-6 libxext6
```

创建桌面快捷方式：

```bash
npm run shortcut
```

Linux 会在系统桌面目录生成「额度桌宠」启动器；如果系统提示不可信，右键选择「允许启动」。快捷方式指向当前检出目录，移动项目后请重新创建。

1. **Codex**：在本机用 ChatGPT 订阅账号登录过 Codex 后，桌宠会自动读取可用登录凭据。
2. **Claude**：用 `claude` 登录过 Claude Code 时优先查询用量接口；也可以使用 Claude 桌面端已有的用量记录。
3. **DeepSeek**：右键宠物 → **设置…**，填入 DeepSeek API Key，点“保存并验证”。Windows 加密可用时，Key 通过 DPAPI 加密保存在本机。
4. **换宠物**：右键宠物 → **切换宠物**，选择本机已有的 Codex 自定义宠物。

只使用其中一家也可以，在设置里关闭暂时不用的服务即可。桌面快捷方式可通过 `npm run shortcut` 创建；Windows 开机自启在右键菜单里开启。

<details>
<summary>Electron 下载或启动遇到问题</summary>

国内网络下载较慢时，可以先在 PowerShell 设置镜像，再运行 `npm install`：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

如果安装后提示找不到 Electron，手动运行 `node node_modules/electron/install.js`，再执行 `npm start`。

</details>

Linux 上如果 Electron 报 `SUID sandbox helper binary ... is not configured correctly`，可在项目目录执行以下命令配置 Chromium 沙箱（重新安装 Electron 后可能需要再次配置）：

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm start
```

桌宠依赖全局鼠标位置和窗口定位；在 Wayland 桌面上会通过 XWayland 运行。纯 Wayland 环境下这些交互功能无法保证。
Linux 使用固定的透明画布，在画布内移动宠物，拖动、散步和弹跳不会反复移动原生窗口。X11 输入区域仅覆盖宠物及气泡，矩形内的透明边缘也可能挡住下方窗口。鼠标位置由 Python 3 通过 libX11 读取，输入区域通过 libXext 设置。

## 支持 Codex 官方宠物格式

QuotaPet 兼容 Codex 桌面端自定义宠物使用的 `pet.json` 与精灵图目录格式。已安装在本机的自定义宠物可以直接复用，无需重新制作动画或转换图片。

除了仓库内置的 `assets/pets/nailong/`，还会扫描以下用户目录；设置了 `CODEX_HOME` 时，第一个位置改为该目录下的 `pets`：

```text
~/.codex/pets/<宠物目录>/
~/.config/quota-pet/pets/<宠物目录>/   # Linux（遵循 XDG_CONFIG_HOME）
%APPDATA%/quota-pet/pets/<宠物目录>/  # Windows
```

用户目录中的同名宠物优先于仓库内置素材，因此可以自行替换奶龙。

每只宠物至少包含：

```text
my-cat/
├── pet.json
└── spritesheet.webp   # 也可以使用 PNG，在 pet.json 中填写实际文件名
```

`pet.json` 示例：

```json
{
  "id": "my-cat",
  "displayName": "我的猫猫",
  "spritesheetPath": "spritesheet.webp",
  "spriteVersionNumber": 2
}
```

| 格式 | 精灵图尺寸 | 动画支持 |
|---|---|---|
| **v1** | 1536 × 1872，8 列 × 9 行 | 待机、奔跑、挥手、跳跃、失败、等待、忙碌、完成等基础状态 |
| **v2** | 1536 × 2288，8 列 × 11 行 | 基础状态，以及 16 个方向的看向帧，可跟随鼠标 |

标准单帧尺寸为 **192 × 208**。图片使用透明背景的 PNG 或 WebP，文件名与 `spritesheetPath` 保持一致。

新安装宠物后，在右键菜单中选择 **切换宠物 → 重新扫描宠物**。没有找到可用素材时，会显示一个备用小圆球。Codex 自定义宠物的创建方式可参考 [OpenAI 官方宠物说明](https://learn.chatgpt.com/docs/pets)。

## 怎么操作

| 操作 | 效果 |
|---|---|
| 单击宠物 | 打开或收起额度面板 |
| 鼠标悬停 | 显示额度摘要 |
| 按住拖动 | 移动宠物，播放奔跑动画；慢慢放下就停在原地 |
| 快速甩开 | 宠物飞出去，撞到屏幕边会弹，最后落在任务栏上 |
| 飞在半空时按住 | 接住它，松手就停在那里，不会打开面板 |
| 在宠物身上来回蹭 | 撸猫：冒爱心、呼噜两声 |
| 右键宠物或托盘 | 刷新、换宠物、调整大小、宠物行为开关、设置、开机自启、隐藏或退出 |
| 面板内按 `Esc` / `F5` | 收起面板 / 立即刷新 |
| 悬停“可用重置卡” | 显示每张卡的到期时间和剩余时长 |

默认每 **5 分钟**刷新一次，可在设置里调整。打开面板时，如果数据超过 1 分钟未更新，也会触发刷新；Codex / Claude 的额度窗口到了重置时间，也会自动补刷一次。默认提醒线为订阅额度剩余 **10%**、DeepSeek 余额 **¥10**。

电脑闲置 5 分钟后宠物会睡觉，刷新降到半小时一次；回来时立即补刷，离开超过 15 分钟或期间额度有变化（重置、被后台任务用掉、DeepSeek 扣费）会冒气泡汇报。散步只沿任务栏上沿、在你最后放下它的位置附近走，被放在半空时不会乱走。这些行为都可以在右键菜单的“宠物行为”或设置里单独关闭。

## 数据来源与边界

| 服务 | 查询方式 | 说明 |
|---|---|---|
| **Codex** | 优先读取 `~/.codex/auth.json` 中的 ChatGPT 登录令牌，直接查询 Codex 后台用量接口；有可用重置卡时再查一次重置卡列表，取每张卡的到期时间 | 正常刷新不需要打开 Codex 桌面端。令牌缺失、失效或直连失败时，才启动一次 `codex app-server`，通过 `account/rateLimits/read` 备用查询，查询完退出。 |
| **Claude** | 优先使用 `~/.claude/.credentials.json` 查询用量接口；否则读取 Claude 桌面端的 `plan-usage-history.json` | 直查可获取接口提供的精确重置时间；桌面端记录受其采样频率限制，重置时间为估算，手动刷新无法让采样更快。 |
| **DeepSeek** | 官方 `GET /user/balance` | API 提供余额；今日 / 本月消费根据本地余额下降量估算，从首次查询开始累计，余额上涨记为充值。 |

Codex 订阅登录令牌与 OpenAI API Key 是两种凭据。Codex 直连地址属于其后台接口，未作为稳定的公开 HTTP API 文档化，因此保留官方 app-server 备用查询。

## 本地存储

- 查询请求只发往对应服务，不上传到本项目自建服务器。网络默认跟随系统代理，也可以手动指定代理。
- 桌宠只读 Codex、Claude 的登录缓存，不自行刷新或改写令牌；Codex 备用查询时，官方 app-server 按自身机制处理续期。
- 配置与用量历史在 Linux 上保存在 `${XDG_CONFIG_HOME:-~/.config}/quota-pet/`，在 Windows 上保存在 `%APPDATA%/quota-pet/`。DeepSeek Key 在 Windows 加密可用时以加密形式存储；余额历史只记录 Key 的哈希，用于区分账号。

宠物在锁屏、休眠或显示器布局变化后会重新校准窗口和鼠标穿透。鼠标穿透由主进程按页面上传的“当前帧透明度图”自行计算，页面卡住也不会让宠物变成点不动的空壳；页面不再处理鼠标消息、崩溃或失去响应时会自动重载，必要时整窗重建，无需手动干预。恢复相关事件保存在配置目录中的 `interaction.log`（轮转备份为 `interaction.log.1`），记录唤醒、锁屏、显示器变化、穿透状态切换、页面无应答和通道停摆的时间；日志不包含令牌、额度或鼠标移动轨迹。

## 开发

| 命令 | 用途 |
|---|---|
| `npm test` | 测试令牌查询与备用通路、数据解析、消费统计、动画、Linux 固定画布和默认宠物 |
| `npm run shortcut` | 为当前检出目录创建 Linux / Windows 桌面快捷方式 |
| `npx electron . --demo --linux-surface-test=out/linux-preview` | 用独立配置和演示额度启动真实 Linux 固定画布，手动验证拖动、弹跳和桌面刷新 |
| `npm run test:interaction` | 在真实 Electron 演示窗口验证系统通知、虚拟显示布局变化和页面卡死/崩溃后的拖动与点击，以及甩出去落地、半空接住，结果写入 `out/interaction-test/report.json` |
| `npm run selftest` | 使用本机登录状态查询真实数据，并输出自检结果 |
| `npx electron . --demo --snapshot=<目录>` | 使用演示数据测试交互，保存宠物、面板和设置截图 |
| `npx electron . --snapshot=<目录>` | 使用本机真实数据测试交互并截图 |

`test:interaction` 使用原有小窗口模式验证通用交互；Linux 的固定画布和真实屏幕刷新请使用 `--linux-surface-test` 验证。

交互演示测试使用输出目录下的独立配置，不修改用户的主题、位置或隐藏设置；虚拟布局测试不会改变 Windows 实际分辨率。真实锁屏、休眠和远程控制切换仍需在日常使用中确认。

```text
main.js               窗口、托盘、菜单、IPC 与刷新调度
preload.js            页面可用的最小接口
src/providers/        Codex / Claude / DeepSeek 数据源
src/quota.js          三家服务的刷新与状态管理
src/pets.js           宠物扫描与精灵图识别
src/linux-surface.js  Linux 固定透明画布与虚拟宠物位置
src/linux-x11.py      X11 指针采样与独立输入区域
assets/pets/nailong/  默认奶龙及第三方素材声明
renderer/physics.js   抛掷、弹跳与散步的物理（主进程和宠物页面共用）
renderer/             宠物、额度面板与设置界面
test/                 自动化测试与演示数据
```

## 声明与许可

本项目为独立个人项目，与 OpenAI、Anthropic、DeepSeek 没有隶属或背书关系。“支持 Codex 官方宠物格式”指素材格式兼容。自定义宠物素材的权利归各自权利人所有。

代码采用 [MIT](LICENSE) 许可证；奶龙等第三方角色素材不适用此 MIT 许可证，详见 [奶龙素材来源与权利说明](assets/pets/nailong/NOTICE.md)。
