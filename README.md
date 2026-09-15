# ComfyUI-MediaBrowser

为 ComfyUI 的现有加载节点提供带缩略图的媒体浏览器。

无需新增节点或修改工作流。安装后，支持的加载节点会出现“浏览资源”按钮，可直接浏览、预览并选择 `input`、`output` 与 `temp` 中的媒体文件。

## 主要功能

- 文件夹浏览、递归检索、文件名搜索、类型筛选与多种排序方式
- 瀑布流与宫格布局，缩略图清晰度可按格子大小独立配置
- 图片、视频与音频预览；图片和视频支持大图翻页
- 收藏、最近使用和常用目录固定入口
- 多选、批量收藏与批量移入系统回收站
- 读取 PNG 或视频中的提示词、参数、工作流与生成耗时
- 可选的本地预览遮蔽，不修改原始文件
- 桌面端、触屏与可缩放窗口布局
- 中文、英文界面，可跟随 ComfyUI 语言

## 安装

### ComfyUI Manager

市场发布准备中，请先使用下方的手动安装方式。

### 手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/xinsulab/ComfyUI-MediaBrowser
```

克隆完成后重启 ComfyUI，无需额外配置。

## 使用

1. 在支持的加载节点上点击“浏览资源”。
2. 使用目录下拉框切换 `input`、`output` 或 `temp`；“收藏”和“最近”位于目录旁边。
3. 点击媒体打开预览；点击绿色勾或预览中的“用这张”完成选择。也可在设置中改为单击直接选择。
4. 右键媒体（触屏长按）可使用收藏、截图、提示词、工作流、遮蔽和回收站等操作。

收藏和最近使用按真实目录分别保存。例如当前目录是 `output`，打开收藏时显示的是 `output` 中收藏的文件。

从 `output` 或 `temp` 选择文件时，插件会自动添加 ComfyUI 所需的目录标记。

## 支持的节点

插件会自动识别使用 ComfyUI 标准 `image_upload`、`video_upload` 或 `audio_upload` 控件的节点，同时显式适配以下常见节点：

| 节点 | 支持内容 |
|---|---|
| `LoadImage`、`LoadImageMask` | `input` 图片 |
| `LoadImageOutput` | `output` 图片 |
| `VHS_LoadVideo`、`VHS_LoadVideoFFmpeg`、`LoadVideoAndSegment_` | `input` 视频 |
| `VHS_LoadAudioUpload` | `input` 音频 |
| Crystools 带元数据图片加载节点 | `input` 图片 |
| `LoadImageGoohai`、`LoadImage //Inspire` | `input` 图片 |

## 可选：预览遮蔽

预览遮蔽支持原图、全幅和局部三种显示方式。局部遮蔽只在浏览器中覆盖检测区域，不会改写磁盘上的媒体文件。

启用局部检测需要：

1. 在浏览器设置中下载推荐 ONNX 模型，或选择兼容的模型文件。
2. 在 ComfyUI 使用的 Python 环境中安装 `onnxruntime`。

模型保存在插件的 `_models/` 目录，不包含在仓库中。无需安装 `nudenet` 或 `ultralytics`。

## 数据与安全

- 收藏、最近使用、界面偏好和单图标记保存在浏览器本地存储中。
- 缩略图和检测结果使用插件本地缓存；源文件变化后缓存会自动失效。
- 删除操作只移入系统回收站，并在执行前确认。
- 预览、提示词读取和耗时索引不会修改原始媒体文件。

## 已知限制

- 视频封面需要 VideoHelperSuite、`imageio-ffmpeg` 或系统 PATH 中可用的 ffmpeg。没有 ffmpeg 时仍可选择和播放视频。
- 部分浏览器不支持 AV1、HEVC 等视频编码；文件本身不受影响。
- 音频不生成缩略图封面。
- JPG 与 WebP 通常不包含 ComfyUI 工作流或完整生成参数。
- 局部检测仅支持插件推荐的检测模型系列，其他结构的 ONNX 文件不能仅通过修改路径直接使用。

## 许可

项目采用 [Apache License 2.0](LICENSE)。仓库不包含检测模型权重。

界面图标来自 [Lucide](https://lucide.dev) 与 [Phosphor Icons](https://phosphoricons.com)，许可声明见 [NOTICE](NOTICE)。
