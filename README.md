# stpd — 面向 AI Agent 的 SillyTavern 预设调试工具

让 agent 在一个**独立的、真实的 SillyTavern** 里加载预设、跑生成、看最终 prompt、批量对比输出，从而快速迭代 Chat Completion 预设。

- **真实管线**：提示词由 ST 前端自己拼装（Prompt Manager、宏、世界书、正则、扩展全部生效），工具用无头浏览器驱动 ST 页面，不自己重新实现。
- **批量生成控制变量**：`batch=N` 时 N 个请求使用**字节级完全相同**的请求体并行发出，只有模型采样不同；结果作为同一条消息的 N 个 swipe 保存。
- **完全隔离**：ST 的配置、数据、密钥都在 `.stpd/` 下，不影响你日常使用的 ST。
- **三种入口**：CLI（JSON 输出）、MCP 服务、直接 CDP 接入浏览器。

## 安装

```bash
npm install
npm run build
node dist/cli.js setup        # clone SillyTavern 1.19.0 到 vendor/、安装依赖、下载 Chromium
```

## 架构

```
agent ──CLI──┐
             ├──> stpd 守护进程 (127.0.0.1:8124) ──> SillyTavern (127.0.0.1:8123, 数据在 .stpd/st-data)
agent ──MCP──┘          │
                         └──> 无头 Chromium（CDP 127.0.0.1:9223，agent 可直接接入）
```

守护进程在第一次调用时自动启动，启动约 6–8 秒。所有改动页面的操作串行执行。

## CLI 用法

```
node dist/cli.js <method> [key=value ...] [--json '{...}']
```

参数值能解析成 JSON 就按 JSON 处理（数字、布尔、数组），否则按字符串处理；`key=@文件` 表示从文件读取。输出都是 JSON，出错时退出码为 1。`node dist/cli.js help` 列出全部命令，`help <method>` 查看参数。

### 典型调试流程

```bash
stpd start                                   # 已启动则什么都不做
stpd set_endpoint provider=custom url=https://api.example.com/v1 api_key=sk-...
stpd set_model model=some-model
stpd set_preset source=./my-preset.json      # 本地路径或 http(s) URL
stpd import_character source=./card.png

stpd inspect_prompt character=Testy message="你好"        # 只拼 prompt 不调模型：最终 messages、分段 token、完整请求体
stpd send_message character=Testy new_chat=true message="你好" batch=4

# 修改 my-preset.json 后：
stpd reload_preset
stpd regenerate character=Testy batch=4      # 删除最后一条回复，在同一上下文上重新生成 N 条
```

（`stpd` 即 `node dist/cli.js`；执行 `npm link` 后可直接用 `stpd`。）

### 命令一览

| 分组 | 命令 |
|---|---|
| 生命周期 | `start` `status` `stop` `restart` |
| 连接 | `list_providers` `set_endpoint` `list_models` `set_model` |
| 预设 | `set_preset` `reload_preset` `list_presets` `get_preset` |
| 角色 | `import_character` `list_characters` |
| 聊天 | `list_chats` `get_chat` `new_chat` |
| 生成 | `send_message` `regenerate` `inspect_prompt` `select_swipe` |
| 扩展 | `list_extensions` `install_extension` `uninstall_extension` `update_extension` `enable_extension` `disable_extension` `get_extension_settings` `set_extension_settings` |
| STscript | `run_slash` |
| 浏览器 | `page_snapshot` `page_screenshot` `page_click` `page_type` `page_select` `page_press` `page_eval` `page_reload` `page_console` |
| 本地 | `setup` `config` `logs` `help` |

## 行为说明

- **预设不会改动连接设置**：初始化时会关闭 ST 的"预设绑定连接"（`bind_preset_to_connection`），所以导入预设不会切换 provider、模型或 URL。连接只由 `set_endpoint` / `set_model` 决定。
- **预设内嵌正则**会被自动导入并授权；导入的角色卡自带的正则也会自动授权。
- **ST 弹窗**在工具操作期间自动确认（例如同名覆盖）。预设中含有代理或自定义端点字段时，选择"原样导入"。
- **生成时强制非流式**（只在生成期间生效，结束后恢复预设原来的设置），不影响输出内容。
- **batch>1 的结果**：第 0 个 swipe 被选为当前回复；用 `select_swipe` 可以选其他 swipe 作为后续上下文。
- **history 参数**：传 `[{role, content}]` 数组，或者 `.json` / `.jsonl`（ST 聊天导出）文件路径。会新建一个聊天，并用它整体替换聊天内容（包括开场白）。
- **输出文件**：每次生成都会在 `.stpd/outputs/` 写入 `*-request.json`（实际发给 ST 后端的请求体）、`*-responses.json`（原始响应）、`*-result.json`（完整结果）。
- **失败**：`failed` 列出失败的请求序号，`upstream_errors` 来自 ST 服务端日志里记录的上游 API 原始报错，`page_console level=toast` 可以查看 ST 的提示。
- **API Key** 只保存在 `.stpd/st-data/default-user/secrets.json`，不会出现在输出或日志中。

## 浏览器控制（兜底能力）

- `page_snapshot selector=#send_form`：带 `[ref=eN]` 的无障碍树；`page_click target=e8` 或 `target='#css'`。
- `page_eval code='return ctx.chat.length'`：在页面中执行 async 函数体，`ctx` = `SillyTavern.getContext()`，`st(path)` = 动态 import ST 模块，例如 `await st("/scripts/openai.js")`。
- `status` 返回 CDP 地址，可以用 `chromium.connectOverCDP('http://127.0.0.1:9223')` 或 `@playwright/mcp --cdp-endpoint` 接入同一个页面。**不要再开第二个 ST 标签页**：ST 以最后一次写入的设置为准，多个标签页会互相覆盖。
- `stpd config headed=true` 后重启，可以看到浏览器窗口。

## MCP

参考 `.mcp.json.example`：每个命令对应一个名为 `st_<method>` 的工具，守护进程自动启动。

## 配置

`stpd config` 查看配置，`stpd config stPort=8123 cdpPort=9223 headed=false` 修改配置，修改后需要 `stop` 再 `start`。运行目录默认是 `.stpd/`，可以用环境变量 `STPD_HOME` 修改。

## 测试

```bash
npm run mock            # 启动 OpenAI 兼容的模拟服务 http://127.0.0.1:8199/v1（模型 mock-a/mock-b/mock-flaky/mock-fail/mock-reasoner）
stpd set_endpoint provider=custom url=http://127.0.0.1:8199/v1 api_key=x
npm run test:mcp        # MCP 冒烟测试
```

模拟服务把每个请求写入 `test/.mock-requests.jsonl`（包括到达时间和 prompt 哈希），可以用来验证批量请求是否真的同时发出、内容是否一致。
