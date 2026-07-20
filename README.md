# Overleafy

[English](README.en.md)

本地 Git 工作树与 Overleaf 项目的双向同步工具。一条命令同步，冲突有备份、能回滚、可诊断。

> ⚠️ 本项目由 Vibe Coding 驱动开发，可能存在非预期行为。如果遇到问题，欢迎在 [Issues](https://github.com/Nyanifold/overleafy/issues) 中反馈。
>
> ⚠️ 当前版本尚未实现完备的多方编辑自动同步校验。如果你同时在 Overleaf 网页和本地编辑了同一文件，请务必先确认内容合并正确再推送，避免意外覆盖丢失更改。

作者：[**Nyanifold**](https://github.com/Nyanifold)

## 安装

```bash
npm install --global @nyanifold/overleafy
```

前提：Node.js ≥ 22.14，Git 任意现代版本，Overleaf 账户开启 Git Integration。

下面是一个完整的入门教程。像平时用 Git 一样——clone、修改、push/pull。

## 教程

### 第 1 步：设置凭证

Overleafy 需要两种凭证：Git Token 用于推送/拉取，Cookie 用于列出项目和下载文件。

**Git Token**（所有用户都需要）——从 Overleaf 左下角 **Account → Account Settings → Git Integration** 复制：

```bash
overleafy auth set-git-token --profile work
# 粘贴 token，按 Enter（输入不回显）
```

**Cookie**（学校/企业 SSO 用户需要）——在浏览器中登录 Overleaf 后导出：

> **Chrome/Edge**：F12 → Application → Cookies → `overleaf.com` → 复制 `overleaf_session` 的值
> **Firefox**：F12 → Storage → Cookies → `overleaf.com` → 同上

```bash
# 方式 A：保存为文件后导入（推荐，避免 shell 历史泄露）
echo "overleaf_session2=..." > ~/overleaf-cookies.txt
chmod 600 ~/overleaf-cookies.txt
overleafy auth import-cookie --profile work --cookie-file ~/overleaf-cookies.txt

# 方式 B：TTY 隐藏输入（不需要文件，粘贴后按 Enter）
overleafy auth import-cookie --profile work
```

如果 Cookie 格式是完整的键值对（含 `=`），直接写进去；如果只有一个值，工具会自动补全
`overleaf_session2=` 前缀。多个 Cookie 用 `; ` 分隔即可。

验证：

```bash
overleafy auth status --profile work
# Profile: work
# Git token: configured
# Browser Cookie: configured
```

### 第 2 步：设置 Git 身份

首次使用需要告诉 Git 你是谁（每仓库只需一次）：

```bash
overleafy config --name "Your Name" --email "you@example.com"
```

### 第 3 步：克隆项目

Project ID 就是 Overleaf 项目 URL 中 `/project/` 后的 24 位十六进制字符串。
也可以用 `overleafy projects list --profile work` 浏览所有项目。

```bash
mkdir my-paper && cd my-paper
overleafy clone 0123456789abcdef01234567 --profile work
```

`clone` 自动完成三件事：
1. `git init` 初始化仓库
2. 绑定 Overleaf 项目——新增 `overleaf` remote，不碰你已有的 `origin`
3. 拉取内容——先尝试 Git pull，如果远程还没有 Git 历史（新项目），则通过
   Cookie 从 Overleaf 网页下载 ZIP 自动解压

如果你已经有本地仓库，用 `bind` 代替：

```bash
overleafy bind --project 0123456789abcdef01234567 --profile work
```

所有凭证（token、cookie）都存在 `~/.overleaf_config.json`（0600），
不会写入 `.git/config`、remote URL、命令输出或日志。

### 第 4 步：日常同步

```bash
overleafy sync     # 双向：拉取 → 合并 → 推送
overleafy pull     # 只从 Overleaf 拉取
overleafy push     # 只推送到 Overleaf
```

`sync` 会自动分析两端状态，按需决定动作：

| 状态 | 含义 | 动作 |
|------|------|------|
| `equal` | 两端一致 | 无操作 |
| `local_ahead` | 本地有新的提交 | push |
| `remote_ahead` | Overleaf 有新提交 | fast-forward 拉取 |
| `diverged` | 两端各有新提交 | 合并，冲突则暂停 |
| `remote_rewritten` | 远端历史被改写 | 暂停，要求明确策略 |

如果你希望在执行前先查看计划：`overleafy plan`，再用 `--plan-id` 执行。
省心模式直接 `overleafy sync` 即可——本地有未提交的修改时自动 checkpoint。

### 第 5 步：处理冲突

冲突发生时，sync 会保留完整现场：

```bash
overleafy conflicts list                  # 查看冲突文件
overleafy conflicts resolve --path main.tex --use ours   # 逐文件解决
overleafy conflicts continue              # 完成合并并推送
# 或者
overleafy conflicts abort                 # 放弃，回滚到合并前
```

### 第 6 步：查看状态

```bash
overleafy status              # 人类可读
overleafy status --json       # 结构化 JSON，适合脚本
```

### 其他命令

| 命令 | 说明 |
|------|------|
| `overleafy projects list --profile work` | 列出 Overleaf 项目 |
| `overleafy bind --project <id>` | 绑定已有仓库 |
| `overleafy bind --project <id> --plan-only` | 仅预览绑定计划 |
| `overleafy unbind` | 移除 Overleaf remote 和绑定配置 |
| `overleafy config --name "…" --email "…"` | 设置当前仓库的 Git 身份 |

所有接受 `--repo <path>` 的命令都可以省略——默认从当前目录向上查找 Git 仓库根。

### CI 环境

```bash
export OVERLEAFY_GIT_TOKEN="your-git-token"
```

该环境变量不会持久化，优先级高于 `~/.overleaf_config.json`。

### AI Agent 集成

本项目附带 [overleafy-guide](skills/overleafy-guide/) Skill，可为 Claude Code、Codex 等 Agent 提供完整的 CLI 操作指南——包括认证绑定、计划审查、同步编辑、冲突恢复和错误诊断。

使用 `overleafy skill` 即可获取完整指南：

```bash
overleafy skill                        # 输出 SKILL.md + 命令参考到终端
overleafy skill -o overleafy-guide.md  # 写入指定文件
overleafy skill -o ./skills/           # 目标为目录时，写入 overleafy-guide.md
overleafy skill --full                 # 复制整个 overleafy-guide 目录到当前目录
overleafy skill --full -o ./skills/    # 复制到指定目录下
```

## 安全设计

- **凭证隔离**：Token/Cookie 存 `~/.overleaf_config.json`（0600），Git 操作使用
  临时 `GIT_ASKPASS` helper 注入——不写入 `.git/config` 或 remote URL
- **输出净化**：日志和 JSON 输出自动遮盖 token、Cookie、CSRF
- **无 shell 注入**：所有子进程用 `execFile` + 参数数组，不走 shell 字符串
- **不丢数据**：合并前创建 `refs/overleafy/backup/` 备份，push 前验证 lease，push 后校验
- **破坏性操作需授权**：force-with-lease、接受远端覆盖必须显式声明策略

## 自托管 Overleaf

```bash
overleafy clone <id> \
  --web-url https://overleaf.example.com \
  --git-url https://git.overleaf.example.com
```

## 架构

```
src/
├── core/       # 领域模型、状态分类、计划器
├── git/        # Git 适配器（快照、fetch、merge、push）
├── overleaf/   # Overleaf 适配器（Git remote、Cookie Web API）
├── config/     # 配置、状态锁、SecretStore
├── cli/        # overleafy 命令行入口
```

核心层不依赖文件系统、子进程或终端 UI——所有外部能力通过 port 注入，CLI 只做解析和序列化。

## 开发

```bash
git clone https://github.com/Nyanifold/overleafy.git
cd overleafy
npm install
npm link
```

```bash
npm run check          # lint + build + test
npm run cli -- --help  # 运行 CLI
```

## License

MIT
