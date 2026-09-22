# 开发与维护

本文面向维护者。安装和使用说明见项目根目录的 [README](../README.md)。

## 运行结构

- `__init__.py`：ComfyUI 插件入口、媒体列表、缩略图、元数据、工作流、回收站和缓存接口。
- `censor.py`：可选 ONNX 检测器、模型下载、检测结果缓存和运行时生命周期。
- `web/mediabrowser.js`：当前主线实际加载的前端入口，包含浮钮入口、多开浏览窗、节点选片和交互逻辑。
- `web/mb-icons.css`：插件自带的 Lucide 与 Phosphor 图标，避免依赖 ComfyUI 内部 CSS 产物。
- `tests/`：Python 行为测试、契约测试和由 Node.js 执行的前端生命周期测试。

ComfyUI 会扫描扩展目录中的 JavaScript。新增前端文件前必须确认加载顺序和运行方式；测试使用的 `.mjs` 位于 `tests/`，不会作为扩展入口加载。如需拆分前端入口，应以当前行为测试作为兼容基线。

页面级头像浮钮（图片加载失败时回退「MB」）在 `setup()` 里挂到 `document.body`，与加载节点按钮并存。浏览窗是独立浮窗，不是全屏遮罩；同时打开的上限是 `PICKER_MAX`（当前 5，改为 `0` 表示不限制）。浏览窗的 z-index 在 `10001–10027` 之间重排，必须低于浮钮 `10028`，也低于大图 / 菜单 / 确认框。关窗会 `abort` 该窗未完成的 `/mediabrowser/list`。列表、缩略图、预览、回收站仍走本插件的 Python 路由，ComfyUI 后端不可用时不能扫盘，界面要换成失败说明而不是留着骨架格。

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
- `/mediabrowser/paint`
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
node tests/run_picker_session.mjs web/mediabrowser.js
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

协作采用短期分支 → PR → Squash 合并到 `main`，每个 PR 在主线保留一个提交。
合并前必须通过 `Tests` 检查、同步最新主线并解决评审讨论。主线禁止强推和删除。
当前为单维护者项目，不要求另一位维护者批准；外部贡献由维护者审阅后合并。

- 媒体路径必须经过根目录约束，不能把字符串前缀判断当成完整越界防护。
- `input`、`output`、`temp` 是真实根目录；收藏和最近只是当前真实根目录上的视图，不能覆盖真实根状态。
- 网络请求和异步列表更新必须受面板生命周期与序号保护，关闭窗口或快速切换目录后不能回填旧结果。
- 删除只允许进入系统回收站；不要添加直接删除用户媒体的路径。
- 新增图标后必须更新 `web/mb-icons.css`，并运行图标自托管测试。
- 业务代码使用中文逻辑注释说明原因、边界、兼容性和风险，不记录已经结束的修改过程。


## 非破坏式遮蔽

`GET /mediabrowser/overlay` 读取按真实文件路径归档的记录，`POST /mediabrowser/overlay` 保存图层。记录使用 `schemaVersion=1`、`sourceVersion`（大小、纳秒时间、显示方向尺寸）、`revision`、`ops` 和 `suppressed`；`ops` 的 `auto` 字段区分自动区域和手工修订，自动区域的 `raw` 保留检测输入供阈值/范围设置重绘。保存必须携带 `expectedRevision`，冲突返回 409。空图层也是正式记录，不能回退到旧检测缓存。

`POST /mediabrowser/render` 使用冻结的图层和显示状态生成 PNG，源文件不变。`keepWorkflow` 只影响文本元数据；预览、复制和截图使用相同合成结果。复制含工作流时额外提供 `text/plain` 工作流 JSON，以兼容会重编码 PNG 的剪贴板。旧 `POST /mediabrowser/paint` 返回 410，防止旧页面覆盖原图。

图层在 `_overlays/` 内原子写入，不随检测缓存清理。每份最多 2000 个操作、50000 个笔刷点，请求上限 2 MiB，图片上限 5000 万像素。路径由 `_resolve` 校验；文件替换后旧版本失效。版本比较和写入由同一锁保护。

前端图层记录缓存和原始检测缓存分离。保存成功通知同页窗口更新；有草稿的窗口保留草稿并提示冲突。编辑器的关闭/翻页需要处理未保存事务，取消恢复进入前开关。导出失败不能回退为未遮蔽原图。

回归覆盖 `tests/test_overlay.py` 与 `tests/run_overlay_lifecycle.mjs`。人工验收需检查：直接智能/手动进入、保存重开、区域移动缩放、清空撤销、关闭取消、重复识别保留修订、缩放和窄屏布局、当前草稿复制以及实际接收端的工作流兼容性。

### 自适应编辑工具与浏览器全屏

编辑工具使用绝对定位浮窗，不参与图片布局；按右侧、左侧和顶部两角的固定候选位置计算与图片的重叠面积，选择遮挡最少的位置。足够宽高时展开辅助操作，受限视口使用「更多」。编辑复用已加载的图层记录及匹配的预览，画布长边限制为 1536 像素，缩放和平移仅更新几何位置；导出仍使用原图分辨率。ResizeObserver 的布局更新通过 requestAnimationFrame 合并，关闭查看器时解除观察并取消待执行帧。全屏使用文档根元素，确保挂在 body 下的查看器和确认框仍可见；fullscreenchange 同步各面板按钮及顶部退出热区。Escape 在全屏期间交给浏览器，避免同时取消编辑。触屏顶部中央热区先显示退出按钮，再点击按钮退出。不支持 Fullscreen API 时显示提示。自动化覆盖见 tests/run_fullscreen_layout.mjs。
