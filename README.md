<div align="center">

<img src="assets/icon.png" width="88" alt="QuotaPet 图标" />

# 额度桌宠 QuotaPet

一只住在桌面角落的“额度宠物”：**点一下**，Codex / Claude 的 5 小时与每周额度、DeepSeek 的余额与消费一目了然。

![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

<img src="docs/preview.png" alt="额度面板（浅色 / 深色主题）" width="860" />

</div>

## 功能一览

仿照 Codex 桌面端的桌宠做的。平时安静待在桌面角落，点一下弹出额度面板：

| 服务 | 能看到什么 |
|---|---|
| **Codex** | 5 小时额度、每周额度（剩余百分比、几点重置）、套餐、可用的“额度重置卡” |
| **Claude** | 5 小时额度、每周额度（登录过 Claude Code 时还有 Opus / Sonnet 周额度和精确重置时间） |
| **DeepSeek** | 账户余额（充值 / 赠金明细）、今日消费、本月消费、近 7 天消费柱状图 |

宠物直接用你在 Codex 里的自定义宠物（`~/.codex/pets`），动画帧表、拖动时的奔跑、眼睛跟着鼠标转，都和 Codex 桌宠一致。界面跟随系统浅色 / 深色主题。

<div align="center">
<img src="docs/states.png" alt="宠物的几种状态" width="760" />
</div>

> 截图里的宠物是演示用的示例素材，额度数据来自 `test/demo-data.js` 里的演示数据。

## 快速开始

需要 **Windows 10 / 11** 和 **Node.js 22+**。

```bash
git clone https://github.com/sj122/quota-pet.git
cd quota-pet
npm install
npm start
```

第一次启动时，宠物会出现在屏幕右下角，任务栏托盘里也会多一个图标。

> - 国内网络下载 Electron 较慢时，可以先设置镜像再安装：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`（PowerShell）。
> - 如果 `npm install` 之后 `node_modules/electron/dist` 里没有 `electron.exe`（启动时提示找不到 Electron），手动运行一次 `node node_modules/electron/install.js` 即可。

1. **右键宠物 → 设置…**，填入 DeepSeek API Key，点“保存并验证”。Key 会用 Windows 加密存储（DPAPI）保存在本机。
2. 想要桌面快捷方式就运行 `npm run shortcut`。
3. 想要开机自动启动：**右键宠物 → 开机自动启动**。

Codex 和 Claude 不需要额外配置：本机登录过 Codex、Claude Code 或 Claude 桌面端，桌宠就能读到额度。

## 操作

| 操作 | 效果 |
|---|---|
| 左键单击宠物 | 打开或收起额度面板 |
| 鼠标停在宠物身上 | 宠物跳一下，弹出一行额度摘要 |
| 按住拖动 | 移动宠物，宠物会朝拖动方向跑 |
| 右键宠物或托盘图标 | 菜单：刷新、切换宠物、大小、眼睛跟随、设置、开机自启、隐藏、退出 |
| 面板里按 `Esc` / `F5` | 收起面板 / 立即刷新 |

宠物的透明区域不挡鼠标，点下去会直接点到后面的窗口。

额度低于提醒线（默认剩余 10%），或者 DeepSeek 余额低于提醒线（默认 ¥10）时，宠物会做出“失败”动作，并冒一个黄色气泡提醒你。

## 数据从哪来

| 服务 | 来源 | 说明 |
|---|---|---|
| Codex | 本机 Codex 自带的 `codex app-server`，调用 `account/rateLimits/read` | 和 Codex 里 `/status` 看到的是同一份数据；令牌刷新、代理都由 codex 自己处理。找不到 codex 时，改用 `~/.codex/auth.json` 直连官方接口（只读，不刷新令牌）。 |
| Claude | ① `~/.claude/.credentials.json`（终端里用 `claude` 登录过 Claude Code 才有）→ 官方用量接口<br>② Claude 桌面端自己记录的 `%APPDATA%\Claude\plan-usage-history.json` | ①能拿到精确值和精确重置时间。②桌面端每隔几分钟记录一次 5 小时 / 每周用量百分比，但没有重置时间，桌宠根据记录推算“预计几点重置”。 |
| DeepSeek | 官方 `GET https://api.deepseek.com/user/balance` | 官方 API 只提供余额。“今日 / 本月消费”是桌宠定时记下余额，按余额下降量推算的，从第一次查询开始累计；充值不会被算成消费。 |

默认每 5 分钟刷新一次。打开面板时，如果数据超过 1 分钟没更新，也会刷新一次。

## 隐私

- 只请求各家的官方接口，不经过任何第三方服务。网络请求默认跟随系统代理，也可以在设置里单独指定代理。
- 不会刷新或改写 Codex、Claude 的登录令牌，不会把你从这两个应用里挤下线。
- 所有配置和历史记录都只保存在本机 `%APPDATA%\quota-pet\`。DeepSeek Key 只以加密形式存在 `config.json` 里，余额历史里只记 Key 的哈希，用来区分不同账号。

## 自定义宠物

桌宠会扫描 `~/.codex/pets/*/pet.json` 和 `%APPDATA%\quota-pet\pets/*/pet.json`。精灵图规格与 Codex 相同：

- 8 列 × 9 行（v1）或 8 列 × 11 行（v2），每格 192×208
- 行 0 待机、1 向右跑、2 向左跑、3 挥手、4 跳、5 失败、6 等待、7 忙碌、8 完成
- v2 的第 9、10 行是 16 个方向的“看向”帧，用来实现眼睛跟着鼠标转

在 Codex 里新做的自定义宠物，在桌宠菜单里点“切换宠物 → 重新扫描宠物”就能用上。一只宠物都没找到时，会先用一颗会呼吸的小圆球顶上。

## 开发

| 命令 | 作用 |
|---|---|
| `npm test` | 单元测试（数据规整、重置时间推算、消费统计、动画表） |
| `npm run selftest` | 在真实环境下把三家数据各读一遍，结果以 JSON 打印 |
| `npx electron . --snapshot=<目录>` | 用合成鼠标事件走一遍悬停、穿透、拖动、点击，并把各窗口截图存到目录里 |
| `npx electron . --demo --snapshot=<目录>` | 同上，但使用 `test/demo-data.js` 里的演示数据 |

```
main.js               主进程：窗口、托盘、菜单、IPC、刷新调度
preload.js            暴露给页面的最小 API
src/providers/*.js    Codex / Claude / DeepSeek 数据源
src/quota.js          三家刷新的统一调度
src/pets.js           扫描宠物、读取精灵图尺寸
renderer/pet.*        宠物窗口（动画、命中测试、拖动、气泡）
renderer/panel.*      额度面板
renderer/settings.*   设置窗口
renderer/shared.js    主进程和页面共用的动画表、格式化与告警规则
```

## 声明

本项目是个人兴趣作品，与 OpenAI、Anthropic、DeepSeek 没有任何关联。各服务的名称和商标归其各自所有者所有。

## 许可证

[MIT](LICENSE)
