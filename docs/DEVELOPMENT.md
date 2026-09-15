# 开发与维护

本文面向维护者。安装和使用说明见项目根目录的 [README](../README.md)。

## 运行结构

- `__init__.py`：ComfyUI 插件入口、媒体列表、缩略图、元数据、工作流、回收站和缓存接口。
- `censor.py`：可选 ONNX 检测器、模型下载、检测结果缓存和运行时生命周期。
- `web/mediabrowser.js`：当前主线实际加载的前端入口，包含节点接入、浏览窗口和交互逻辑。
- `web/mb-icons.css`：插件自带的 Lucide 与 Phosphor 图标，避免依赖 ComfyUI 内部 CSS 产物。
- `tests/`：Python 行为测试、契约测试和由 Node.js 执行的前端生命周期测试。

ComfyUI 会扫描扩展目录中的 JavaScript。新增前端文件前必须确认加载顺序和运行方式；测试使用的 `.mjs` 位于 `tests/`，不会作为扩展入口加载。如需拆分前端入口，应以当前行为测试作为兼容基线。

## 后端接口

主要 GET 接口：

- `/mediabrowser/list`
- `/mediabrowser/thumb`
- `/mediabrowser/meta`
- `/mediabrowser/workflow`
- `/mediabrowser/regions`
- `/mediabrowser/usage`
- `/mediabrowser/censor/status`

主要 POST 接口：

- `/mediabrowser/clipinfo`
- `/mediabrowser/trash`
- `/mediabrowser/purge`
- `/mediabrowser/censor/download`
- `/mediabrowser/censor/download/cancel`
- `/mediabrowser/censor/settings`

路由、查询参数和响应字段由 `tests/test_mediabrowser.py` 中的契约测试保护。调整接口时应同步更新真实生命周期测试，避免只检查源码字符串。

## 验证

在插件仓库根目录执行：

```bash
node --check web/mediabrowser.js
python -m compileall -q __init__.py censor.py
python -m pytest -q
```

完整 pytest 会调用 Node.js 执行前端生命周期脚本。开发机需要能从 PATH 运行 `node`。

可单独执行以下前端测试：

```bash
node tests/run_place_helpers.mjs web/mediabrowser.js
node tests/run_layer_stack.mjs web/mediabrowser.js
node tests/run_list_lifecycle.mjs web/mediabrowser.js
node tests/run_selection_lifecycle.mjs web/mediabrowser.js
```

更新自带图标或核验耗时索引时使用仓库工具：

```bash
python tools/gen_icons.py
python tools/verify_elapsed.py <ComfyUI output 目录>
```

图标生成器需要能导入 `comfyui_frontend_package`；也可以通过 `--fe` 指向其 `static/assets` 目录。

真实 ComfyUI 环境的人工冒烟可将 `tests/smoke.js` 粘贴到浏览器控制台，执行 `await mbSmoke()`。涉及响应式布局时至少检查：桌面宽窗、手动缩窄窗口、触屏模式、顶栏换行和格子最小尺寸。

## 修改原则

- 媒体路径必须经过根目录约束，不能把字符串前缀判断当成完整越界防护。
- `input`、`output`、`temp` 是真实根目录；收藏和最近只是当前真实根目录上的视图，不能覆盖真实根状态。
- 网络请求和异步列表更新必须受面板生命周期与序号保护，关闭窗口或快速切换目录后不能回填旧结果。
- 删除只允许进入系统回收站；不要添加直接删除用户媒体的路径。
- 新增图标后必须更新 `web/mb-icons.css`，并运行图标自托管测试。
- 业务代码使用中文逻辑注释说明原因、边界、兼容性和风险，不记录已经结束的修改过程。
