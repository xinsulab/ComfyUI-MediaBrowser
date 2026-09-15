# -*- coding: utf-8 -*-
"""重新生成 web/mb-icons.css —— 从 ComfyUI 前端构建产物中提取项目使用的图标规则。

执行时机：新增图标，或 ComfyUI 前端升级并变更图标集之后。
执行方式（仓库根目录）：python tools/gen_icons.py
生成后由 tests/test_mediabrowser.py 中的 test_icons_are_self_hosted 验证图标覆盖。

图标名以字符串传入 mbIco/setIco，源码中没有 icon-[...] 字面量。
因此先提取符合命名规则的字符串，再以前端构建产物中的实际规则进行过滤。"""
import glob
import re
import sys
from datetime import date
from pathlib import Path


def frontend_assets() -> str:
    """定位 ComfyUI 前端包的 assets 目录。

    优先通过 comfyui_frontend_package 获取实际位置，避免依赖特定机器路径。
    导入不可用时，从当前文件向上定位 ComfyUI 根目录；最后由 --fe 显式指定。
    """
    for i, a in enumerate(sys.argv):
        if a == "--fe" and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    try:
        import comfyui_frontend_package                      # noqa: PLC0415
        p = Path(comfyui_frontend_package.__file__).parent / "static" / "assets"
        if p.is_dir():
            return str(p)
    except Exception:
        pass
    # 退路：插件通常在 <ComfyUI>/custom_nodes/<本插件>/tools/
    here = Path(__file__).resolve()
    for up in here.parents:
        cand = up / ".venv" / "Lib" / "site-packages" / \
            "comfyui_frontend_package" / "static" / "assets"
        if cand.is_dir():
            return str(cand)
    raise SystemExit(
        "找不到 ComfyUI 前端包。请在装了 comfyui_frontend_package 的那个 Python 里跑，\n"
        "或者显式指定：python tools/gen_icons.py --fe <.../static/assets>")


FE = frontend_assets()
print(f"前端包: {FE}")

blob = "".join(Path(f).read_text(encoding="utf-8", errors="ignore")
               for f in glob.glob(str(Path(FE) / "*.css")))
if not blob:
    raise SystemExit(f"{FE} 中没有 .css 文件，请检查 --fe 路径")

src = Path("web/mediabrowser.js").read_text(encoding="utf-8")
# 图标名是传入 mbIco/setIco 的字符串，需要先按命名格式提取，
# 再根据前端构建产物中是否存在对应规则进行过滤。
used = sorted({n for n in re.findall(r'"([a-z0-9]+--[a-z0-9-]+)"', src)
               if r"icon-\[" + n + r"\]" in blob})

rules, missing = [], []
for name in used:
    m = re.search(re.escape(f"icon-\\[{name}\\]") + r"\{[^}]*\}", blob)
    if m:
        # 上游合并产物可能把同一 vendor 声明叠加多次；保留一份即可，
        # 否则每个图标都携带相同死声明，生成文件会无意义膨胀。
        rule = re.sub(
            r"(?:-webkit-mask-image:var\(--svg\);){2,}",
            "-webkit-mask-image:var(--svg);",
            m.group(0),
        )
        rules.append(rule)
    else:
        missing.append(name)
if missing:
    raise SystemExit(f"这些图标在打包里找不到: {missing}")

header = f"""/* MediaBrowser 自带的图标。
 *
 * 内置原因：icon-[xxx] 类原本由 ComfyUI 前端的 UnoCSS 构建产物提供，
 * 属于上游内部实现。内置已使用的规则可避免上游图标集变更导致界面图标缺失，
 * 并保证前端测试可以独立执行。
 *
 * 内容：{len(rules)} 条规则，SVG 以 data-URI 内联，运行时不请求外部图标资源。
 * 生成自 comfyui_frontend_package 的打包 CSS（{date.today().isoformat()}）。
 *
 * 更新方式：
 *   1. 确认新图标存在于 ComfyUI 前端构建产物中。
 *   2. 运行 tools/gen_icons.py 重新生成本文件。
 *   3. 运行 test_icons_are_self_hosted 验证所有引用的图标均已内置。
 *
 * 请勿手工修改生成规则：宽高使用 1.2em 跟随字号，颜色使用
 * background-color:currentColor；改变这些属性可能导致图标尺寸或颜色不一致。
 */
"""
out = header + "\n" + "\n".join(rules) + "\n"
Path("web/mb-icons.css").write_text(out, encoding="utf-8", newline="\n")
print(f"web/mb-icons.css: {len(rules)} 条规则, {len(out)} 字节 ({len(out)/1024:.1f} KB)")
