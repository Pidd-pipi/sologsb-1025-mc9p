# 多语言应急通知撰写与发布前检查工具

面向应急值班、编辑、法务、翻译和发布人员的纯前端发布工作台。项目可离线起草，数据自动保存到浏览器 `localStorage`，刷新或断网后继续编辑。

## 功能

- 按事件类型、严重程度、影响范围、时间窗口和发布渠道配置通知。
- 简体中文、英文、日文等多语言版本并列编辑，可标记必需语言和翻译复核状态。
- 内置台风转移、计划停水、公共安全三类可复用模板。
- 发布前检查必填字段、禁用词、术语一致性、时间冲突、语言缺失和未解决讨论。
- 编辑、法务、翻译、发布人四类角色确认和退回流程。
- 逐句选择正文并添加、解决讨论。
- 锁定最终版本、从锁定稿发起紧急修订，并保留历史版本。
- 基于 LCS 的两版逐句差异比较。
- `Ctrl/Cmd+Z` 撤销、`Ctrl/Cmd+Shift+Z` 或 `Ctrl/Cmd+Y` 重做、`Ctrl/Cmd+S` 手动保存。

## 技术栈

- Angular 19 + TypeScript
- Nebular UI
- Angular Forms / RxJS
- 浏览器 localStorage
- Nginx 静态部署

## 本地开发

```bash
npm install
npm run start
```

开发服务器监听 `4200`，宿主端口仅由部署时映射，源码未写入 `10025`。

## 生产构建

```bash
npm install
npm run build
```

构建产物位于 `dist/emergency-notice/browser`。

## Docker

```bash
docker build -t sologsb-1025 .
docker run --rm -p 10025:80 sologsb-1025
```

容器内 Nginx 监听 `80`，访问 `http://localhost:10025`。数据仅保存在当前浏览器，不会上传服务器。
