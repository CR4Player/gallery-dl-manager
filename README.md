# gallery-dl-manager

基于官方 `ghcr.io/mikf/gallery-dl:latest` + `exiftool` 的 Docker 化定时调度与网页管理控制台，面向 NAS 与 Immich 工作流设计（不内置媒体缩略图浏览，专注于抓取调度、尾部滚动实时日志、SQLite Archive 去重、Cookie/输入列表管理、ExifTool 时区修正与异常通知）。

## 核心特性

- **预构建多架构镜像（GHCR）**：通过 GitHub Actions 自动测试并构建 `linux/amd64` + `linux/arm64` 镜像（每周自动重打一次以跟随上游最新 `gallery-dl`），NAS 端无需本地编译，直接 `docker compose pull` 更新。
- **开箱导入与统一配置**：支持按站点管理 Cookie（Netscape `cookies.txt` / JSON / Header）、用户名密码、User-Agent/Browser、`filename` 与 `skip` 策略；可选首次启动只读导入现有 `gallery-dl.conf`（自动剥离 Windows 版 `exiftool.exe`/`powershell` 钩子）。
- **灵活的定时调度与输入列表 (`-i`)**：按任务独立维护 Cron 表达式（带中文描述与下次执行倒计时）、代理覆盖、Skip 策略、`--range` 等额外 CLI 参数、`.txt` 链接列表上传/绑定（`/data/inputs/*.txt`），以及任务批量启停/删除。
- **高性能尾部实时日志 + 顶栏通知中心**：SSE 推送尾部 300–400 行滚动日志窗口、实时新增/跳过/后处理计数与「新增文件列表」，完整日志落盘可随时下载；顶栏铃铛集中展示异常与推送失败，支持跳转、已读与清除。
- **SQLite Archive 与 Twitter 永久红心同步**：支持单文件回填（`archive-event: ["file", "skip"]`）；内置 `/api/archive/twitter-ids` 与预配置 Tampermonkey 油猴脚本，汇总 `archive.sqlite3`、本地磁盘目录与 X 官方 `like.js`，在网页端永久标出已点赞推文。
- **智能 ExifTool 后处理**：内置 `app/postprocess.py` 自动区分图片（写入本地时区 EXIF + OffsetTime）与视频（QuickTime UTC + DateTimeOriginal），并精确同步文件 `mtime`；同时支持自定义日期模板与 `exec` 指令。
- **全站访问保护与多通道通知**：首次启动在日志打印一次性 `[SETUP]` 初始化口令，通过 `/setup` 设定管理员密码；支持 Telegram、飞书（含签名校验）、Bark 与通用 Webhook 失败及恢复推送。

## 使用预构建镜像部署

```sh
mkdir -p ./gallery-dl-manager/data ./gallery-dl-manager/downloads
cd ./gallery-dl-manager
# 准备 docker-compose.yml 和 .env（按需设置 PUID/PGID/DOWNLOAD_HOST_DIR）
cp .env.example .env
chown -R 1026:100 ./data ./downloads
docker compose pull
docker compose up -d
```

查看首次初始化口令：

```sh
docker compose logs gallery-dl-manager
```

访问 `http://<NAS-IP>:8766/setup` 完成管理员密码设置。

## 常用运维

- 更新到最新构建与最新上游 `gallery-dl`：
  ```sh
  docker compose pull && docker compose up -d
  ```
- 重置网页登录密码：
  ```sh
  docker compose exec gallery-dl-manager python3 -m app.main --reset-web-auth
  ```
- 健康检查地址：`http://<NAS-IP>:8766/health`
