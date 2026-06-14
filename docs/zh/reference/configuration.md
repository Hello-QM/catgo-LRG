# 配置参考

CatGo 会从环境变量、应用内 *Settings* 对话框，以及 `~/.catgo/` 下的配置文件读取配置。Settings 对话框中的修改会立即生效；环境变量修改需要重启应用。

## 用户数据目录

| 路径 | 内容 |
|------|----------|
| `~/.catgo/` | 所有持久化用户数据的默认根目录 |
| `~/.catgo/databases/` | SQLite 数据库（工作流状态、面板状态、结构缓存） |
| `~/.catgo/agents/<provider>/` | 每个 provider 对应的 CatBot 工作目录 |
| `~/.catgo/logs/` | Sidecar 和 agent 日志 |

可用下面的环境变量覆盖根目录：

```bash
export CATGO_HOME=/path/to/your/dir
```

该覆盖在所有平台，以及 AppImage / `.deb` / `.dmg` 构建中都会生效。

## 环境变量

### 应用

| 变量 | 默认值 | 用途 |
|----------|---------|---------|
| `CATGO_HOME` | `~/.catgo` | 用户数据、数据库、agent 目录的根目录 |
| `CATGO_LOG_LEVEL` | `info` | 可选值：`trace`、`debug`、`info`、`warn`、`error` |
| `CATGO_SERVER_PORT` | `8000` | Python 后端端口 |
| `CATGO_AGENT_PORT` | `8765` | `catgo-agent` Node sidecar 端口 |
| `PYTHON` | from `PATH` | 开发前端使用的 Python 解释器路径 |

### AI Providers（CatBot）

| 变量 | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Claude |
| `GEMINI_API_KEY` | Gemini |
| `OPENAI_API_KEY` | Codex |

密钥也可以在 *Settings -> Chat* 中输入；应用内对话框会把它们加密存储在操作系统 keychain 中（macOS 上是 Keychain，Windows 上是 Credential Manager，Linux 上是 libsecret）。

### 材料数据库

| 变量 | 用途 |
|----------|---------|
| `MP_API_KEY` | Materials Project（MP 查询需要） |
| `OPTIMADE_PROVIDERS` | 要查询的 OPTIMADE provider ID，用逗号分隔 |

### HPC

| 变量 | 用途 |
|----------|---------|
| `VASP_PSP_DIR` | VASP PAW 赝势路径（POTCAR 生成器使用） |
| `CATGO_HPC_DEFAULT` | 默认 HPC 主机昵称（对应 *Settings -> HPC* 中的一项） |

## 配置文件

`~/.catgo/config.json` - 全局应用偏好（主题、查看器默认值、计算器默认值）。尽量通过 *Settings* 修改。

`~/.catgo/hpc.json` - HPC 主机注册表。格式如下：

```json
{
  "hosts": [
    {
      "nickname": "shaheen",
      "hostname": "shaheen.hpc.kaust.edu.sa",
      "user": "you",
      "key_path": "~/.ssh/id_ed25519",
      "scheduler": "slurm",
      "workdir": "/scratch/you/catgo"
    }
  ]
}
```

`~/.catgo/agents/<provider>/settings.json` - 每个 provider 对应的 CatBot 设置（system prompt、允许的工具、默认面板）。

## 后端端点

Python sidecar 暴露以下 HTTP 端点。对 token 更友好的操作（文件上传、结构导出、面板修改）应优先通过这些端点完成，而不是走 MCP 服务器。

| 端点 | 用途 |
|----------|---------|
| `/api/view/upload-and-load` | Multipart 上传并加载到查看器 |
| `/api/view/structure/export?format=...` | 下载当前结构 |
| `/api/view/structure/merge-upload` | Multipart 上传并合并到当前面板 |
| `/api/workflow/*` | 工作流引擎 CRUD 和控制 |
| `/api/mcp/` | MCP 协议端点（用于外部 agent） |
| `/health` | 存活探针 |

完整请求/响应 schema 见[服务器 API](/zh/tutorials/server/server-api)。
