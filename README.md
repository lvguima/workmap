# Workmap

Workmap 是一个 Obsidian 插件。它把「时段笔记」（一期约 10 天，例如 `2026/12/1-10.md`）里的任务画成一张工作地图，主要有这几块：

- **周期任务**：这一期要推进的几条主线，带星标（重要程度）、截止日期、备注和进度，拖动调整顺序。
- **今日四象限**：按「重要 / 紧急」把当天的任务分进四个列表。没做完的自动顺延，并显示拖了几天。
- **日程**：把任务排进当天的时段。
- **本期笔记**：学习笔记、会议记录单独存成文件，挂在这一期下面。
- **AI 回顾 / 出题**：通过 DMXAPI 调用大模型，根据本期的任务和笔记写复盘、出复习题。
- **工作助理**：右侧边栏的对话面板，有今日简报、随时提问，建议的改动确认后才写进笔记。

所有改动都会直接写回 md 文件。md 是唯一的数据源，在编辑器里改笔记，视图会跟着刷新。

## 安装

1. 把本仓库克隆到库的插件目录：

   ```bash
   cd <你的库>/.obsidian/plugins
   git clone https://github.com/lvguima/workmap.git
   ```

2. 在 Obsidian「设置 → 第三方插件」里启用 **Workmap**。
3. 点左侧栏的网格图标，或者运行命令「打开 Workmap」。也可以在笔记里放一个 `obsidian://workmap` 链接。

插件是纯 JavaScript，不需要构建。`main.js`、`manifest.json`、`styles.css` 就是 Obsidian 加载的文件。

## 文档

- [功能文档](docs/features.md)：怎么用、笔记格式、命令和设置
- [设计文档](docs/design.md)：数据模型、写回机制、代码结构和设计取舍

## 开发

```bash
npm install   # 只装测试要用的 moment
npm test      # 语法检查 + 纯函数单元测试
```

改完 `main.js` 或 `styles.css` 后，重启 Obsidian，或者在设置里关掉再打开插件，改动就会生效。

个人设置保存在 `data.json` 里（时段、顺延记录、API 密钥），已在 `.gitignore` 中排除。
