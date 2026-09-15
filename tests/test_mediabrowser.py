"""MediaBrowser 的回归测试。

只测三块**错了会静默出错**的逻辑 —— 不是凑覆盖率：

1. 路径收敛：错了 = 任何登录用户能读服务器上任意文件（真发生过，见 README）
2. 来源标注：错了 = 从 output 选的图入队被拒，而错误信息完全不提这回事
3. 提示词提取：错了 = 正负向对调，你照着复制的是反的

跑法（在 ComfyUI 的 venv 里）：
    python -m pytest custom_nodes/ComfyUI-MediaBrowser/tests -q
不装 pytest 也能跑：
    python custom_nodes/ComfyUI-MediaBrowser/tests/test_mediabrowser.py
"""
import json
import os
import re
import sys

# 让 import 找得到插件本体；同时假装有 ComfyUI 的两个模块，
# 这样测试不用真起一个 ComfyUI
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import types

if "folder_paths" not in sys.modules:
    fake = types.ModuleType("folder_paths")
    _base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_fixture")
    fake.get_input_directory = lambda: os.path.join(_base, "input")
    fake.get_output_directory = lambda: os.path.join(_base, "output")
    fake.get_temp_directory = lambda: os.path.join(_base, "temp")
    sys.modules["folder_paths"] = fake

if "server" not in sys.modules:
    srv = types.ModuleType("server")

    class _Routes:
        def get(self, *a, **k):
            return lambda f: f

        def post(self, *a, **k):
            return lambda f: f

    class _PS:
        instance = types.SimpleNamespace(routes=_Routes())

    srv.PromptServer = _PS
    sys.modules["server"] = srv

import __init__ as mb  # noqa: E402


# ── 1. 路径收敛 ────────────────────────────────────────────────
def test_resolve_blocks_traversal():
    """.. 跳出根目录必须被拒。"""
    for bad in ["../secret.txt", "a/../../x", "../../.env"]:
        try:
            mb._resolve("output", bad)
        except ValueError:
            continue
        raise AssertionError(f"越界没被挡住: {bad}")


def test_resolve_blocks_absolute():
    """绝对路径必须被拒 —— os.path.resolve 的语义是「后段是绝对路径就丢弃前面」，
    单用它等于没防。"""
    for bad in ["C:/Windows/win.ini", r"C:\Windows\win.ini", "/etc/passwd", "//server/share/x"]:
        try:
            mb._resolve("output", bad)
        except ValueError:
            continue
        raise AssertionError(f"绝对路径没被挡住: {bad}")


def test_resolve_blocks_degenerate_names():
    """全是点或空格的路径段必须被拒 —— Windows 会把结尾的点和空格吃掉，
    "......" 归一化之后就成了根目录本身。"""
    for bad in ["......", "  ", "a/.../b", "./ / ."]:
        try:
            mb._resolve("output", bad)
        except ValueError:
            continue
        raise AssertionError(f"畸形路径段没被挡住: {bad}")


def test_resolve_allows_normal():
    """正常的子路径要放行，别把功能一起挡了。"""
    p = mb._resolve("output", "sub/dir/a.png")
    root = os.path.abspath(mb._DIRS["output"]())
    assert p.startswith(root + os.sep), p


def test_resolve_sibling_prefix_not_confused():
    """content-backup 不是 content 的子目录 —— 比前缀时必须带分隔符。

    少了 os.sep 的话，"根目录名 + 任意后缀" 的兄弟目录会被当成根内路径放行。
    """
    root = os.path.abspath(mb._DIRS["output"]())
    sibling = os.path.basename(root) + "-backup"
    try:
        mb._resolve("output", "../" + sibling + "/x.png")
    except ValueError:
        return
    raise AssertionError("同前缀的兄弟目录被当成了根内路径")


def test_resolve_absolute_sibling_of_root():
    """指向「根目录名 + 后缀」的绝对路径必须被拒。

    这条专门盯 `startswith(root + os.sep)` 里的那个分隔符：
    少了它，.../output-backup 会因为字符串前缀匹配被当成 .../output 里面的路径。
    用绝对路径而不是 "../"，是因为 ".." 会先被上面的畸形段检查拦掉，
    根本走不到这道判据 —— 那样测的就不是这条逻辑（变异测试实测发现的）。
    """
    root = os.path.abspath(mb._DIRS["output"]())
    try:
        mb._resolve("output", root + "-backup" + os.sep + "x.png")
    except ValueError:
        return
    raise AssertionError("同前缀的兄弟目录被当成了根内路径")


def test_extract_zero_out_when_dedup_cannot_save():
    """归零节点必须**自己**挡住，不能指望去重兜底。

    上面那条 zero_out 测试里，正负向文本相同，去重那一步顺手就把它清了 ——
    于是「回溯遇归零即停」这道闸被拆掉也测不出来（变异测试实测发现的）。
    这里让正负向指向**不同**文本：负向经归零节点连到 A，正向直连 B。
    没有归零拦截的话，A 会被当成负向内容报出来。
    """
    g = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "AAA 正向内容", "clip": ["9", 0]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "BBB 另一段", "clip": ["9", 0]}},
        "2": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
        "9": {"class_type": "CLIPLoader", "inputs": {"clip_name": "x.safetensors"}},
        "10": {"class_type": "KSampler", "inputs": {
            "positive": ["1", 0], "negative": ["2", 0], "steps": 8,
        }},
    }
    r = mb._extract_positive(g)
    assert r["positive"] == ["AAA 正向内容"], r["positive"]
    assert r["negative"] == [], f"归零节点上游的文本被当成了负向: {r['negative']}"


def test_extract_dedup_direction():
    """同一段文本正负向都摸得到时，判它是正向而不是负向。

    去重方向写反过（`pos = [p for p in pos if p not in neg]`）——
    结果正向被整段删掉、只剩一个标着「负向」的正向词，用户照着复制就是反的。
    """
    g = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "同一段词", "clip": ["9", 0]}},
        "9": {"class_type": "CLIPLoader", "inputs": {"clip_name": "x.safetensors"}},
        # 正负向接同一个文本节点（有些流真这么写）
        "10": {"class_type": "KSampler", "inputs": {
            "positive": ["1", 0], "negative": ["1", 0], "steps": 8,
        }},
    }
    r = mb._extract_positive(g)
    assert r["positive"] == ["同一段词"], f"正向被去重删掉了: {r}"
    assert r["negative"] == [], r["negative"]


# ── 2. 提示词提取 ──────────────────────────────────────────────
def _sampler_graph(pos_text, neg_text=None, zero_out=False):
    g = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": pos_text, "clip": ["9", 0]}},
        "10": {"class_type": "KSampler", "inputs": {
            "positive": ["1", 0], "negative": ["2", 0],
            "steps": 20, "cfg": 7.0, "sampler_name": "euler",
        }},
        "9": {"class_type": "CLIPLoader", "inputs": {"clip_name": "x.safetensors"}},
    }
    if zero_out:
        # 很常见的写法：把正向归零当负向用，省一个空文本节点
        g["2"] = {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["1", 0]}}
    else:
        g["2"] = {"class_type": "CLIPTextEncode", "inputs": {"text": neg_text or "", "clip": ["9", 0]}}
    return g


def test_extract_basic():
    r = mb._extract_positive(_sampler_graph("a cat on a table", "blurry, worst quality"))
    assert r["positive"] == ["a cat on a table"], r["positive"]
    assert r["negative"] == ["blurry, worst quality"], r["negative"]
    assert r["params"]["steps"] == 20


def test_extract_zero_out_not_mistaken_for_negative():
    """负向接的是 ConditioningZeroOut(正向) 时，不能把正向文本当成负向。

    这条曾经错过：回溯穿过归零节点摸到上游的正向文本，加上去重方向也反了，
    结果正向被整段删掉、只剩一个标着「负向」的正向词。
    """
    r = mb._extract_positive(_sampler_graph("a cat on a table", zero_out=True))
    assert r["positive"] == ["a cat on a table"], f"正向丢了: {r}"
    assert r["negative"] == [], f"归零节点被当成负向内容: {r}"


def test_extract_no_sampler_is_empty():
    """没有采样器的图（纯图形处理流）不该硬凑出提示词。"""
    r = mb._extract_positive({"1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}}})
    assert r["positive"] == [] and r["negative"] == []


def test_extract_guess_only_when_nothing_found():
    """条件链上什么都没摸到时才走兜底（VLM 反推流的形状）。"""
    g = {
        "5": {"class_type": "easy showAnything",
              "inputs": {"text": "极简主义日式人像摄影，静谧庄重氛围，光线柔和均匀"}},
        "10": {"class_type": "KSampler", "inputs": {"steps": 4}},
    }
    r = mb._extract_positive(g)
    assert r["positive"] == [] and r["negative"] == []
    assert len(r["guess"]) == 1, r["guess"]


def test_extract_guess_skips_paths_and_short():
    """兜底不能把文件名模板、短开关值当成提示词。"""
    g = {
        "1": {"class_type": "SaveImage",
              "inputs": {"filename_prefix": "out/%year%-%month%/%year%%month%%day%_x"}},
        "2": {"class_type": "X", "inputs": {"text": "enable"}},
        "10": {"class_type": "KSampler", "inputs": {"steps": 4}},
    }
    r = mb._extract_positive(g)
    assert r["guess"] == [], r["guess"]


# ── 3. 来源标注 ────────────────────────────────────────────────
def test_annotate_input_plain():
    """input 必须是裸相对路径 —— 加后缀 Comfy 会去 input 里找「a.png [input]」。"""
    assert mb.annotate_widget_value("a.png", "input") == "a.png"


def test_annotate_output_suffix():
    """output 必须带 [output]，否则入队报 Invalid image file。"""
    assert mb.annotate_widget_value("sub/a.png", "output") == "sub/a.png [output]"


def test_annotate_temp_suffix():
    assert mb.annotate_widget_value("a.png", "temp") == "a.png [temp]"


# ── 4. 缩略图档位 ──────────────────────────────────────────────
def test_thumb_sizes_are_clamped():
    """px 必须落到固定几档 —— 否则每个像素值切一份缓存，磁盘迟早爆。

    期望值跟着 THUMB_SIZES 走：动阶梯就要同步动这里，
    顺便逼人确认「哪个请求会落到哪一档」是不是自己想要的。
    """
    for want, expect in [(1, 256), (256, 256), (300, 256), (384, 384), (400, 384),
                         (512, 512), (640, 640), (700, 640), (900, 1024), (1300, 1536),
                         (1800, 2048), (4000, 2048)]:
        got = mb.clamp_thumb_px(want)
        assert got == expect, f"px={want} 落到了 {got}，应为 {expect}"
    for s in (1536, 2048):
        assert s in mb.THUMB_SIZES


def test_thumb_cache_dedups_tiers_above_source_size():
    """档位比原图长边还大时，几档产出完全相同 —— 缓存必须归一，不能各存一份。

    thumbnail() 只缩不放：1280x1278 的图在 1536 / 2048 / 原像素三档下
    出图和体积一模一样（实测都是 33KB）。缓存键带 px 的话就存三份。
    而这类图不少：抽样 300 张 output，长边中位数 1536，
    2048 档下 76% 的图根本不会被缩小。
    """
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "__init__.py"), encoding="utf-8").read()
    i = src.find("async def mediabrowser_thumb")
    body = src[i:i + 2400]
    if "_DIMS.get(filename)" not in body:
        raise AssertionError("thumb 路由应当查已有的尺寸索引来归一 px")
    if "THUMB_NATIVE" not in body:
        raise AssertionError("超过原图长边的档位应当归一到原像素档")
    if "long_edge" not in body:
        raise AssertionError("缺少与原图长边的比较")


def test_native_px_tier_is_exact_not_nearest():
    """原像素档（px=0）必须精确匹配，不能参与「取最近档」。

    走最近档的话 0 会被吸到 256 —— 用户点了「原像素」反而拿到最糊的一档，
    而且不报错，只是看起来没生效。
    """
    assert mb.THUMB_NATIVE == 0
    assert mb.clamp_thumb_px(0) == 0, "px=0 被吸到了别的档"
    assert mb.THUMB_NATIVE in mb.THUMB_SIZES
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "__init__.py"), encoding="utf-8").read()
    # 图片：px=0 时不能调 thumbnail
    i = src.find("def _make_thumb")
    if "if px:" not in src[i:i + 700]:
        raise AssertionError("_make_thumb 在 px=0 时必须跳过缩放")
    # 视频：px=0 时不能拼出 scale='min(0,iw)'，那会算出 0 宽让 ffmpeg 报错
    j = src.find("def _video_thumb")
    seg = src[j:j + 1400]
    if "if px:" not in seg:
        raise AssertionError("_video_thumb 在 px=0 时必须整个不加 scale 滤镜")


def test_thumb_quality_is_not_too_low():
    """webp 质量太低时人物图的皮肤和发丝会出可见的块。"""
    assert mb.THUMB_QUALITY >= 80, f"THUMB_QUALITY={mb.THUMB_QUALITY} 偏低"


def test_every_storage_key_is_registered_for_cleanup():
    """每个 mediabrowser.* 键都必须登记进 PREF_KEYS 或 MARK_KEYS。

    漏登记 = 「清空设置 / 清空标记」清不掉它，而且**用户完全看不出残留在哪** ——
    只会觉得"我明明清过了怎么还是老样子"。
    手写清单迟早漏（CENSOR_ONE_KEY 就漏过），所以这里反着查：
    扫出所有键，逐个确认有归属。

    键有两种写法，**都要扫**：
      ① 常量：const FOO_KEY = "mediabrowser.foo"  → 登记表里写常量名
      ② 裸串：save("mediabrowser.size", …)        → 登记表里写字符串本身
    只扫①的话，谁直接 save 一个新裸串，这个守卫会一声不吭
    （2026-09-04 审出：当时 5 个裸串键碰巧都登记了，纯属运气）。
    """
    src = _mediabrowser_js()
    const_names = set(re.findall(r'const (\w*_KEY) = "mediabrowser\.', src))
    assert const_names, "一个存储键都没扫到？提取规则多半失效了"

    # 裸串键 = 源码里出现过的 "mediabrowser.*" 减去已有常量承载的那些
    all_literals = set(re.findall(r'"(mediabrowser\.[A-Za-z.]+)"', src))
    by_const = set(re.findall(r'const \w*_KEY = "(mediabrowser\.[A-Za-z.]+)"', src))
    bare = all_literals - by_const

    def listed(name):
        m = re.search(r"const " + name + r" = \[(.*?)\];", src, re.S)
        return m.group(1) if m else ""

    registry = listed("PREF_KEYS") + listed("MARK_KEYS")
    orphan = sorted([k for k in const_names if k not in registry]
                    + [k for k in bare if '"' + k + '"' not in registry])
    if orphan:
        raise AssertionError(
            f"这些键没登记进 PREF_KEYS / MARK_KEYS，清空时会留残留: {orphan}")


def test_undetected_images_show_by_default():
    """局部档下、还没检测的图，默认必须是**原图**，不是糊的。

    2026-09-02 把它硬编码成「先糊着」，配上「检测不跟着滚动走」，往下滚就是
    一片永远解不开的糊 —— 想看只能一张张点眼睛，而且点之前根本不知道那是什么图。
    默认值一旦被改回 blur，那个死胡同立刻复发，所以在这里钉死。
    要「先全遮住、检测清一张露一张」的人去设置里开 —— 那是个真实场景
    （有人在旁边时慢慢翻），不是「全幅」的重复：全幅是永远不露。
    """
    src = _mediabrowser_js()
    m = re.search(r"const censorWaitBlurs = \(\) =>(.+?);", src)
    assert m, "缺 censorWaitBlurs —— 未检测图的显示方式得有唯一入口"
    expr = m.group(1)
    assert 'CENSOR_WAIT_KEY, "show"' in expr, \
        f"默认值必须是 show（显示原图），现在是：{expr.strip()}"


def test_censor_wait_is_reachable_from_settings():
    """这个开关必须能在设置里改，还得当场生效。

    只留一个 localStorage 键、界面上没有入口 = 用户只能靠 F12 改，等于没做。
    改完还必须立刻重画：要求用户切一次档或重开窗口才看到效果，
    他会以为这个开关坏了。
    """
    src = _mediabrowser_js()
    assert "censorwait" in src.lower(), "设置面板里没有这个开关的入口"
    assert "先全部遮住" in src, "缺「先全部遮住」这一档的界面文案"
    i = src.index('lay.querySelector(".censorwait")')
    body = src[i:i + 600]
    assert "applyLocalCaches()" in body, "改完没重画 —— 用户会以为开关没生效"


def test_censor_mode_buttons_only_switch_modes():
    """档位按钮只切档。「已在局部时再点 = 重扫」这个隐藏行为必须消失。

    同一个按钮两种后果，用户无从预期：想切回局部看一眼的人，
    触发的是一次十几秒的检测。检测现在有自己的按钮。
    """
    src = _mediabrowser_js()
    assert 'censorMode === "local") startInfer()' not in src, \
        "档位按钮还在兼职触发检测 —— 拆出去的按钮才该是唯一入口"


def test_detection_has_exactly_one_entry_point():
    """检测只留一个入口：贴在「局部」旁边的那个图标。

    之前唯一入口是底部提示条里一句灰色文字链。在「先全部遮住」下，
    用户会对着一屏糊图找不到出路 —— 违反「无死胡同」。
    两个入口也不行：状态会各说各的。
    """
    src = _mediabrowser_js()
    # 只查 "mb-detect" 在不在是不够的：CSS 里有那条规则就能满足，
    # 按钮压根不建也照样绿。要查真的写在顶栏模板里、真的接上。
    assert 'class="mb-detect"' in src, "检测按钮没写进顶栏"
    i = src.index("const syncDetectBtn")
    body = src[i:src.index("const updateUnhitHint", i)]
    assert "startInfer()" in body, "检测按钮没接上 startInfer —— 点了不会检测"
    assert "inferAbort?.abort()" in body, "检测中点它不会取消"
    assert "infer-miss" not in src, "底部提示条还留着可点链接 —— 检测只该有一个入口"


def test_detect_control_does_not_reflow_the_toolbar():
    """检测入口必须是钉在「局部」旁的定宽图标，脸上不写会变长的字。

    切到局部才插入「检测这一屏 12」、检测中改成「检测中 9/24 · 取消」，
    顶栏左右跳，下面格子跟着抖。图标一直在、宽高不变；跑起来用角上的点，
    数量和说明进 tooltip。
    """
    src = _mediabrowser_js()
    i = src.find('class="mb-ops-g mb-censor-g"')
    assert i >= 0, "顶栏遮蔽那一组找不到"
    chunk = src[i:i + 1200]
    assert 'data-censor="local"' in chunk and "mb-detect" in chunk, (
        "检测图标必须跟在局部按钮旁边，不能事后再塞")
    assert 'mbElButton("mb-detect")' not in src, "运行时再建会在切档时让顶栏跳一截"
    body = src[src.find("const syncDetectBtn"):src.find("const updateUnhitHint")]
    assert "btn.textContent" not in body, "syncDetectBtn 不能改脸上的字，否则宽度跟着变"
    assert "btn?.remove()" not in body, "切走局部不能拆掉图标 —— 拆掉顶栏会缩回去"
    assert "busy" in body, "检测中要靠 class 标状态，不能靠换文案"
    assert "mb-detect.busy::after" in src or "mb-leak" in src, "跑起来要有不占布局的漏点"
    assert re.search(r"\.mb-detect\{[^}]*min-width", src) or "min-width:36px" in src.replace(" ", ""), (
        "图标要定宽，不能跟着内容撑开")


def test_detection_progress_is_shown_in_one_place():
    """进度只显示一处 —— 就在你刚点的那个图标的说明里。

    原来写在底部提示条里，按钮在顶栏、进度在底栏，眼睛要跨半个窗口找；
    而且两处各维护一套状态，改一处忘一处。脸上不能写进度，否则顶栏会跳。
    """
    src = _mediabrowser_js()
    assert "检测眼前 {done}/{total}" not in src, "进度还写在底部提示条里"
    assert "检测中 {done}/{total}" in src, "图标说明里没有进度"
    assert 'btn.textContent = t("检测中' not in src, "进度不能写在按钮脸上"
    body = src[src.find("const syncDetectBtn"):src.find("const updateUnhitHint")]
    assert "hint.textContent" in body, "触屏看不见 tooltip，忙时进度还得写在底栏"


def test_no_stale_copy_about_clicking_the_mode_button():
    """检测拆成独立按钮之后，「再点局部就会检测」这类说法全是错的。

    文案骗人比没有文案更糟：用户会照着点，然后发现什么都没发生，
    转而怀疑功能坏了。这里把已经不成立的说法钉死。
    """
    src = _mediabrowser_js()
    for bad in ("滚动不会自动接着检", "再点「局部」", "点一下检测眼前这一屏",
                "局部只处理眼前看得见的图"):
        assert bad not in src, f"陈旧文案还在：{bad}（检测已拆成独立按钮）"


def test_first_screen_does_not_wait_for_every_dimension():
    """挡在首屏响应前面的算尺寸预算，只够眼前一两屏，不是 600 张。

    算一张尺寸 = 开一次文件读头（冷盘更贵）。原来一次请求最多算 600 张，
    **全部挡在响应前面** —— 而用户第一眼只看得到二三十格。
    剩下的挪到响应之后在后台补：索引照样会热，但不再让人干等。
    """
    assert mb.DIM_BUDGET_SYNC < mb.DIM_BUDGET, \
        f"同步预算({mb.DIM_BUDGET_SYNC}) 应当明显小于后台预算({mb.DIM_BUDGET})"
    assert mb.DIM_BUDGET_SYNC <= 160, \
        f"同步预算 {mb.DIM_BUDGET_SYNC} 还是太大 —— 首屏看得见的就那么几十格"


def test_fill_dims_honours_an_explicit_budget():
    """_fill_dims 得能按调用方给的预算算，否则拆不出「先给一屏、其余后台」。"""
    import inspect
    sig = inspect.signature(mb._fill_dims)
    assert "budget" in sig.parameters, "_fill_dims 没有 budget 参数，预算写死在函数里"


def test_index_writes_do_not_block_the_listing():
    """写索引不能挡着列目录的响应。

    _remember_known_elapsed 是**写**操作，响应内容压根不依赖它的结果，
    却被 await 着 —— 用户白等一次磁盘写。后台跑，回头有就有。
    """
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "..", "__init__.py"), encoding="utf-8").read()
    i = src.index("async def mediabrowser_list")
    # 不能切到第一个 return —— 那是「未知类型」的提前返回，正文还没开始
    body = src[i:src.index('"sort": sort,', i)]
    assert "await loop.run_in_executor(_POOL, _remember_known_elapsed" not in body, \
        "还在 await 索引写盘 —— 响应不依赖它，不该等"
    assert "_remember_known_elapsed" in body, "索引不写了？那改名之后就认不出耗时了"
    assert "_spawn_bg" in body, "后台任务没走 _spawn_bg —— 异常会被静默吞掉"


def test_there_is_a_way_back_to_the_top():
    """记住上次滚动位置之后，必须给一条回顶部的路。

    重开窗口会停在上次看到的地方（那是对的，接着翻不用重新找），
    但一个逛到几千格深处的人想回最上面，只能一路往回滚。
    记忆和回顶这两件事必须成对出现，缺一个就是把人关在半路。
    """
    src = _mediabrowser_js()
    assert "mb-totop" in src, "缺回顶部按钮"
    # 锚在接线上，不是 CSS —— 光有样式没有 onclick 就是个点不动的装饰
    i = src.index('.mb-totop").onclick')
    body = src[i:i + 500]
    assert "scrollTo" in body or "scrollTop = 0" in body, "回顶按钮没接上滚动"
    # 重开窗口会直接停在上次那个深处，那一刻按钮就得在
    j = src.index("scroll.scrollTop = q ? 0")
    assert "syncToTop()" in src[j:j + 200], "恢复滚动位置之后没同步按钮显隐"


def test_icon_css_rules_are_actually_class_selectors():
    """自带图标的每条规则都得是**类**选择器（带前导点）。

    2026-09-04 查出：33 条规则全写成 `icon-\\[lucide--x\\]{…}`，少了那个点。
    CSS 把它当成元素选择器，去找一个名叫 `icon-[lucide--x]` 的标签 ——
    永远匹配不到 `<i class="icon-[lucide--x]">`，整份文件一条没生效。
    而图标看着是好的，因为 ComfyUI 自己的 UnoCSS 恰好也提供这些 class ——
    这个文件存在的唯一理由就是「不依赖它」，等于白写，还完全不报错。

    上面那条 test_icons_are_self_hosted 只核对名字在不在文件里，
    名字在、选择器废，照样通过 —— 所以必须单独守选择器这一层。
    """
    css = open(os.path.join(_web_dir(), "mb-icons.css"), encoding="utf-8").read()
    bad = [ln.split("{")[0] for ln in css.splitlines()
           if ln.startswith("icon-")]
    assert not bad, f"这些规则少了前导点，是元素选择器不是类选择器: {bad[:3]}（共 {len(bad)} 条）"
    good = [ln for ln in css.splitlines() if ln.startswith(".icon-")]
    assert len(good) >= 30, f"只扫到 {len(good)} 条类选择器规则，提取规则多半失效了"


def test_cache_usage_is_reported():
    """得能看见缓存用了多少、离自动淘汰的上限还有多远。

    两份缓存本来就有 LRU 自动淘汰（缩略图 8000 个、检测框 20000 个，
    按最后访问时间先删最久没碰的）。但界面上只有三个「清」按钮，
    不告诉你现在多大、要不要清 —— 用户只能凭感觉点，点完也不知道清掉了什么。
    有了数字，「清」这件事才有判断依据，也才验得出清完是不是真的少了。
    """
    out = mb._cache_usage()
    for k in ("thumbs", "regions"):
        assert k in out, f"用量里缺 {k}"
        rec = out[k]
        for f in ("n", "cap", "bytes"):
            assert f in rec, f"{k} 缺字段 {f}"
        assert rec["cap"] > 0, f"{k} 的上限得是正数，现在是 {rec['cap']}"
        assert rec["n"] >= 0 and rec["bytes"] >= 0


def test_purge_endpoint_returns_usage_so_the_panel_can_refresh():
    """清理响应返回新用量，统计目录不能占用事件循环线程。"""
    import asyncio
    import threading
    from unittest.mock import patch
    caller = threading.get_ident()
    usage = {"thumbs": {"n": 0}, "regions": {"n": 2}}

    class Request:
        async def json(self):
            return {"what": "thumbs"}

    def stat():
        assert threading.get_ident() != caller
        return usage

    with patch.object(mb, '_purge_what', return_value={"thumbs": 3}), \
         patch.object(mb, '_cache_usage', side_effect=stat):
        response = asyncio.run(mb.mediabrowser_purge(Request()))
    assert json.loads(response.body)['usage'] == usage


def test_cache_usage_counts_thumbnails_not_indexes():
    """「缩略图 N 个」只能数缩略图。索引文件不是缩略图。

    2026-09-04 用户清完缓存看到「3 个」，磁盘上其实一张缩略图都没有 ——
    那 3 个是 _dims.json / _elapsed.json 和一个 .part 残留。
    数字骗人比没数字更糟：他据此以为「清理清错了东西」。
    """
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        old = mb.CACHE_DIR
        mb.CACHE_DIR = td
        try:
            for name in ("a.webp", "b.webp",                      # 真缩略图
                         "_dims.json", "_elapsed.json",           # 索引
                         "_dims.json.abc123.part", "c.webp.x.part"):  # 半成品
                with open(os.path.join(td, name), "w", encoding="utf-8") as f:
                    f.write("x")
            got = mb._cache_usage()["thumbs"]
        finally:
            mb.CACHE_DIR = old
    assert got["n"] == 2, (
        f"应当只数出 2 张缩略图，实际 {got['n']} —— "
        "索引和 .part 半成品被当成缩略图数进去了")


def test_auto_trim_never_deletes_the_indexes():
    """自动淘汰绝不能删掉尺寸 / 耗时索引。

    _purge_what 排除了它们，_trim_thumb_cache **没有**（2026-09-04 查出）。
    缓存超过 8000 个时，索引会跟缩略图一起进淘汰名单，按访问时间排到前面就被删。
    删了不报错，表现只是「怎么每次列目录都变慢了」——最难查的那种。
    """
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        old_dir, old_cap, old_tick = mb.CACHE_DIR, mb._THUMB_MAX_FILES, mb._trim_tick
        mb.CACHE_DIR = td
        mb._THUMB_MAX_FILES = 4          # 逼它必须淘汰
        mb._trim_tick = 0                # 下一次 tick=1，一定真跑
        try:
            # 索引先建 = 最老，按访问时间排序会排在最前面，正是最容易被误删的位置
            for name in ("_dims.json", "_elapsed.json"):
                with open(os.path.join(td, name), "w", encoding="utf-8") as f:
                    f.write("{}")
            for i in range(12):
                with open(os.path.join(td, f"t{i}.webp"), "w", encoding="utf-8") as f:
                    f.write("x")
            mb._trim_thumb_cache()
            left = set(os.listdir(td))
        finally:
            mb.CACHE_DIR, mb._THUMB_MAX_FILES, mb._trim_tick = old_dir, old_cap, old_tick
    for idx in ("_dims.json", "_elapsed.json"):
        assert idx in left, f"自动淘汰把索引 {idx} 删掉了 —— 它不是缩略图"
    thumbs = [n for n in left if n.endswith(".webp")]
    assert len(thumbs) < 12, f"根本没淘汰？还剩 {len(thumbs)} 张，上限是 4"


def test_a_tap_only_counts_on_the_cell_it_started_on():
    """触屏：格子的 click 必须是「按下和抬起都在这一格」才算数。

    2026-09-04 用户报：触屏点节点上的「浏览资源」，窗口弹出来的同时
    直接打开了某一张图。原因是弹层出现在手指底下，浏览器随后合成的 click
    落到了新出现的格子上 —— 典型幽灵点击，鼠标不会有（没有合成事件）。
    只挡「开窗后若干毫秒」是靠时间赌，改成要求这一格自己收到过 pointerdown。
    """
    src = _mediabrowser_js()
    # 锚在媒体格那一处（目录格另有自己的 onclick，靠 openViewerAt 区分）
    i = src.index("if (clickOpensViewer()) { openViewerAt(it.path); return; }")
    body = src[max(0, i - 900):i]
    assert "downOn" in body, "格子的 click 没要求配对的 pointerdown —— 挡不住幽灵点击"
    assert "if (!real) return;" in body, "收到 click 时没据此拦下没配对的那次"
    # 不许退回「开窗后 N 毫秒内不认」那种赌时间的挡法
    assert "setTimeout" not in body, "别用时间窗挡幽灵点击 —— 机器慢一点就漏"


def test_thumb_url_changes_when_the_file_does():
    """缩略图 URL 必须带 mtime，否则原地覆盖的图会显示七天旧封面。

    2026-09-05 查出：响应头写着 max-age=604800（7 天），旁边注释说
    「键里带 mtime，可以放心长缓存」—— 但带 mtime 的是**服务端缓存文件名**
    （thumb_key），URL 只有 filename/type/px。

    于是原地覆盖一张图（路径不变、内容变了）：服务端会正确生成新缩略图，
    可浏览器请求的是同一个 URL，max-age 期内**连问都不问**，
    接下来七天看到的都是旧图。而且完全不报错。

    把 mtime 放进 URL，文件一变 URL 就变，长缓存才真的安全。
    """
    src = _mediabrowser_js()
    # 每一处拼 thumb URL 的地方都要带，漏一处就是那一处显示旧图
    spots = [m.start() for m in re.finditer(r"/mediabrowser/thumb\?filename=", src)]
    assert len(spots) >= 2, f"只扫到 {len(spots)} 处 thumb URL，提取规则多半失效了"
    for i in spots:
        chunk = src[i:i + 320]
        assert "&t=${" in chunk, (
            "这处 thumb URL 没带 mtime，覆盖同名文件后会显示旧图七天：\n"
            + src[i:i + 160].strip())


def test_thumb_timing_is_measurable():
    """缩略图生成必须有耗时统计，否则「慢」这件事只能靠猜。

    2026-09-05 用户报首屏还是慢，问「看日志能看出原因吗」——
    整份日志里 MediaBrowser 只有一行「局部遮蔽已就绪」，零埋点，
    于是只能猜是不是档位太大。猜没有价值：先能量，才谈得上优化。
    统计要**按尺寸档分开**：640 和 1536 的成本差一个量级，混在一起的均值没意义。
    """
    mb._THUMB_STATS.clear()
    mb._note_thumb(640, 0.10, hit=False)
    mb._note_thumb(640, 0.30, hit=False)
    mb._note_thumb(640, 0.00, hit=True)
    mb._note_thumb(1536, 1.00, hit=False)

    rec = mb._THUMB_STATS[640]
    assert rec["gen"] == 2, f"640 档应当记到 2 次生成，实际 {rec['gen']}"
    assert rec["hit"] == 1, f"640 档应当记到 1 次缓存命中，实际 {rec['hit']}"
    assert abs(rec["sec"] - 0.40) < 1e-6, f"640 档累计耗时应当是 0.40，实际 {rec['sec']}"
    assert abs(rec["max"] - 0.30) < 1e-6, f"640 档最慢应当是 0.30，实际 {rec['max']}"
    assert 1536 in mb._THUMB_STATS, "不同尺寸档必须分开统计 —— 成本差一个量级"

    line = mb._thumb_stats_line()
    assert "640" in line and "1536" in line, f"汇总没把各档都写出来: {line}"
    mb._THUMB_STATS.clear()


def test_hover_styles_do_not_stick_on_touch():
    """触屏上 :hover 会在点完之后一直粘着 —— 每条 hover 规则都得挡掉。

    手指没有「移开」这个动作，点一下之后浏览器把那个元素留在 hover 态，
    看起来就像按钮卡住了，而鼠标环境不会出现这个现象。

    为什么不用 @media (hover: none)：带触摸屏的笔记本**两样都有**，
    (hover: hover) 成立，CSS 认为你有鼠标 —— 代码里早有这段注释。
    所以按真实 pointerType 在 <html> 上打 .mb-touch，用它来挡。

    为什么用 :where()：它**特异性为 0**，加了不改变任何既有优先级。
    直接写 `html:not(.mb-touch) .mb-skip:hover` 会让 hover 反超 `.mb-skip.on`，
    点完之后「已跳过」那个状态色会被 hover 色盖掉 —— 修一个坏一个。
    """
    src = _mediabrowser_js()
    css = src[:src.index("`;", src.index("const MB_CSS"))] if "const MB_CSS" in src else src
    naked = []
    for m in re.finditer(r"(?m)^([^\n{]*:hover[^\n{]*)\{", css):
        sel = m.group(1)
        for part in sel.split(","):
            part = part.strip()
            if ":hover" in part and not part.startswith(":where(html:not(.mb-touch))"):
                naked.append(part)
    assert not naked, (
        f"这些 hover 规则没挡触屏，点完会一直高亮（共 {len(naked)} 条）: {naked[:3]}")


def test_touch_flag_lives_on_the_document_root():
    """.mb-touch 必须打在 <html> 上，不能只打在浏览窗里。

    设置面板、确认框、单张菜单这些浮层大多 appendChild 到 document.body，
    在 .mb-box 之外 —— 只在浏览窗上打标记的话，那些浮层的按钮照样粘 hover。
    """
    src = _mediabrowser_js()
    assert "documentElement.classList.toggle(\"mb-touch\"" in src, \
        ".mb-touch 没打在 document.documentElement 上，body 层的浮层挡不住"


def test_scrolling_does_not_fire_thumbnail_requests():
    """滚动过程中不发缩略图请求，停下才发。

    浏览器对同源只给 6 个并发连接（本机实测 HTTP/1.1）。快滑时这 6 个槽位
    全被「根本不会看的图」占着，等你停下真想看的那一屏排在后面。
    """
    src = _mediabrowser_js()
    i = src.index("if (scrolling)")
    body = src[i:i + 200]
    assert "dataset.src" in body, "滚动中没把 URL 挂起来，还是直接发了"
    assert "else img.src = thumbUrl;" in body, "静止时应当直接发，别也拖 120ms"


def test_pending_thumbs_are_found_by_scanning_not_by_a_list():
    """待发的图靠**扫渲染池**找，不靠另存一份清单。

    第一版维护了一个 pending Map，它和池子会不同步 —— 漏掉某一格，
    那一格就永远空着，没有任何人再管它，而且不报错。
    用户的原话是「有很多半天都扫描不出来」。
    扫池子是无状态的：这次没补上，下次停下再扫一遍就补上。
    """
    src = _mediabrowser_js()
    i = src.index("const flushThumbs")
    body = src[i:src.index("const scheduleFlush", i)]
    assert "for (const [i, el] of pool)" in body, "没有扫渲染池 —— 又在维护清单了"
    assert 'querySelector("img[data-src]")' in body, "没按 data-src 找待发的图"
    assert "sort" in body, "补发时没排序 —— 会按池子顺序而不是离视口中心远近"


def test_vhs_preview_is_told_the_real_root():
    """选了 output/temp 里的视频，要把根目录告诉 VHS 的预览部件。

    2026-09-05 用户报「没法选视频」。查下来后端其实是通的
    （VHS 声明了 VALIDATE_INPUTS(s, video)，ComfyUI 因此跳过「必须在下拉选项里」
     的内置检查，见 execution.py:1019；它自己走 exists_annotated_filepath，认标注）。
    坏的是**预览**：VHS 前端对上传版节点这么解析（VHS.core.js:1949）

        let parts = ["input", value];                       // type 写死 input
        let extension = parts[1].slice(lastIndexOf(".")+1); // 从整串取扩展名

    于是 `xx.mp4 [output]` 被解析成 type=input、format="video/mp4 [output]"，
    预览去 input 里找 → 404 → 看起来就是「选不了」。

    修法：写完值之后按标注把 filename/type/format 算对，调它的 updateParameters。
    """
    src = _mediabrowser_js()
    i = src.index("onPick: (name, root) =>")
    assert "fixVhsPreview(node, name, root)" in src[i:i + 400], \
        "选中之后没去修正 VHS 的预览参数 —— 选 output 里的视频会预览 404"

    j = src.index("function fixVhsPreview")
    fn = src[j:src.index("function attachButton", j)]
    assert "updateParameters" in fn, "没调 VHS 的 updateParameters"
    assert "type: root" in fn, "type 没按真实根目录给 —— VHS 会当成 input 去找"
    assert "VHS_IMAGE_EXT" in fn, "没按 VHS 的规则区分 image/video 格式"
    # 扩展名要从**去掉标注的**文件名上取，不能从整串取（那正是 VHS 的 bug）
    assert "name.slice(name.lastIndexOf" in fn, "扩展名取法会把标注也截进去"
    ext = src[src.index("const VHS_IMAGE_EXT"):src.index("\n", src.index("const VHS_IMAGE_EXT"))]
    for e in ("gif", "webp", "avif"):
        assert e in ext, f"VHS_IMAGE_EXT 少了 {e}，跟 VHS.core.js 那份对不上"


def test_long_scrolls_still_get_thumbnails():
    """连续滚动再久，也不能一直不加载 —— 「不发」必须有上限。

    2026-09-05 用户报「扫图完全坏了，很久没有图出现」。全量回归是绿的，
    因为坏的不是某个不变量，是**设计**：
    「滚动中一律不发、停下 120ms 才发」碰上惯性滑动（触屏能滑好几秒），
    整段时间一张都不出。改之前是边滚边发，所以这一版对长滑动严格变差。

    现在给「不发」加个上限：距上次发出去超过 MAX_DEFER 就强制发一批，
    不管还在不在滚。批量的好处还在（不会每帧都发），但饿不死。
    """
    src = _mediabrowser_js()
    m = re.search(r"const THUMB_MAX_DEFER_MS = (\d+)", src)
    assert m, "「最多憋多久」没有上限 —— 长滑动期间会一直不出图"
    ms = int(m.group(1))
    assert ms <= 500, f"上限 {ms}ms 太长，长滑动时人已经在等了"
    i = src.index("const scheduleFlush")
    body = src[i:i + 500]
    assert "THUMB_MAX_DEFER_MS" in body, "上限没接进 scheduleFlush，等于没有"


def _purge_handler(src, act):
    """取出某个清理按钮的 onclick 函数体（到下一个 lay.querySelector 为止）。"""
    head = 'lay.querySelector("[data-purge=' + act + ']").onclick'
    i = src.index(head)
    j = src.find("lay.querySelector(", i + len(head))
    return src[i:j if j > 0 else len(src)]


def test_restoring_defaults_actually_restores_the_live_window():
    """「恢复默认界面」清了键，界面就得**当场**跟上，不能要求用户重开窗口。

    窗口大小、触屏模式、点击行为和浏览范围都只在建窗时初始化，清掉存储键后
    必须显式同步内存与样式，否则当前窗口会继续显示旧状态。
    """
    src = _mediabrowser_js()
    i = src.index("const applyPrefsLive = ")
    body = src[i:src.index("};", i)]
    for need, why in (
        ("syncClickMode()", "光标样式不会跟着回默认"),
        ("mediabrowser.boxsize", "窗口大小不会跟着回默认，得重开窗口才生效"),
        ('"mediabrowser.touch"', "触屏模式不会跟着回默认"),
        ("setTouch(auto, false)", "触屏状态没有通过统一入口同步到面板与 html"),
        ("scopeWithRoot(", "浏览范围不会回到节点默认真实目录"),
        ("syncScopeButtons()", "收藏/最近按钮会留下错误激活态"),
    ):
        assert need in body, f"applyPrefsLive 少了 {need} —— {why}"


def test_restore_defaults_copy_names_what_it_actually_clears():
    """按钮副文案必须点到会被清掉的**要命项**，尤其是语言。

    2026-09-04 审出：文案只写「格子、递归、类型、排序、遮蔽滑条」，
    实际连界面语言一起清。把界面设成英文的人点一下会变回中文，毫无预告。
    系统明明知道要清哪些键，却只说了其中 5 项 —— 违反「事实随行」。
    """
    src = _mediabrowser_js()
    i = src.index('data-purge="prefs"')
    line = src[i:src.index("</div>", i)]
    assert "语言" in line, "副文案没提语言，但这个按钮会把界面语言一起清掉"


def test_purge_dir_leaves_no_empty_shells():
    """清完不该在磁盘上留一整棵空目录树。

    _regions/ 按分片建子目录。只删文件的话，「已清检测框 N 个」之后
    去看目录还是满满一片文件夹 —— 用户会觉得根本没清干净。
    根目录要留着：插件启动时就建了它，删掉下次写还得重建。
    （不用 pytest 的 tmp_path fixture —— 这个文件也支持不装 pytest 直接跑，
      _run_all() 是无参调用的。）
    """
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        root = os.path.join(td, "cache")
        deep = os.path.join(root, "ab", "cd")
        os.makedirs(deep)
        for p in (os.path.join(deep, "x.json"),
                  os.path.join(root, "ab", "y.json"),
                  os.path.join(root, "z.json")):
            with open(p, "w", encoding="utf-8") as f:
                f.write("{}")

        n = mb._purge_dir(root)

        assert n == 3, f"应当删掉 3 个文件，实际 {n}"
        assert os.path.isdir(root), "根目录不该被删掉"
        left = os.listdir(root)
        assert left == [], f"还留着空目录壳: {left}"


def test_every_destructive_purge_asks_first():
    """三个不可撤销的清理都要先问一句，一个都不能省。

    2026-09-04 审出：清标记、完全重置都有 confirmAsk，唯独「恢复默认界面」
    直接执行 —— 一键抹掉全部设置、不可撤销、无预告，三个里防护最弱的反而是它。
    """
    src = _mediabrowser_js()
    for act in ("prefs", "marks", "all"):
        body = _purge_handler(src, act)
        assert "confirmAsk" in body, f"[data-purge={act}] 没有确认框 —— 清理不可撤销"


def test_every_model_label_is_configurable():
    """模型的 18 类必须**一个不落**都能在界面上勾。

    漏一类 = 那个部位永远遮不了，而且不报错 —— 用户翻遍设置也找不到。
    多一类 = 死选项，勾了永远不生效（模型根本不输出它）。
    这条盯的是「模型升级加了新类」：加了类不同步界面，就会静默漏掉。
    """
    import censor
    src = _mediabrowser_js()
    m = re.search(r"const CENSOR_LABEL_GROUPS = \[(.*?)\n\];", src, re.S)
    if not m:
        raise AssertionError("找不到 CENSOR_LABEL_GROUPS")
    ui = set(re.findall(r'"([A-Z_]+)"', m.group(1)))
    model = set(censor.LABELS)
    missing = sorted(model - ui)
    if missing:
        raise AssertionError(f"这些类界面上配不了，永远遮不掉: {missing}")
    extra = sorted(ui - model)
    if extra:
        raise AssertionError(f"这些类模型不会输出，是死选项: {extra}")
    # 每一类都要有中文名，否则界面上直接露出 FEMALE_BREAST_EXPOSED 这种内部标识符
    names = re.search(r"const CENSOR_LABEL_NAME = \{(.*?)\n\};", src, re.S)
    named = set(re.findall(r"(\w+):", names.group(1)))
    unnamed = sorted(ui - named)
    if unnamed:
        raise AssertionError(f"这些类没有中文名，界面会露出内部标识符: {unnamed}")


def test_default_cover_set_is_the_four_key_parts():
    """默认只遮要害四类，且模型确实没有「乳头」类。

    臀 / 男胸不在默认里：多数图里不构成问题，遮了反而糊掉一大块画面。
    NudeNet 640m 的 18 类里最细的就是 FEMALE_BREAST_EXPOSED（整个乳房），
    没有 NIPPLE —— 想只盖中心得靠「胸部单独缩小」，不能指望换标签。
    """
    import censor
    assert "NIPPLE" not in " ".join(censor.LABELS), (
        "模型多了 NIPPLE 类？那默认名单和「胸部单独缩小」的说法都要重写")
    assert len(censor.LABELS) == 18, f"标签数变了({len(censor.LABELS)})，默认名单要重新核"

    src = _mediabrowser_js()
    m = re.search(r"CENSOR_LABELS_DEFAULT = \[(.*?)\]", src, re.S)
    if not m:
        raise AssertionError("找不到 CENSOR_LABELS_DEFAULT")
    got = set(re.findall(r'"([A-Z_]+)"', m.group(1)))
    want = {"FEMALE_GENITALIA_EXPOSED", "MALE_GENITALIA_EXPOSED",
            "ANUS_EXPOSED", "FEMALE_BREAST_EXPOSED"}
    if got != want:
        raise AssertionError(f"默认名单应为要害四类，现在是 {sorted(got)}")


def test_breast_cover_is_separate_from_global():
    """胸部的缩放必须独立于全局「打码范围」。

    合成一个的话，为了「只盖乳头」把范围调小，会连下体的框一起缩掉 ——
    而下体恰恰是最该盖满的那个。
    """
    src = _mediabrowser_js()
    for name in ("CENSOR_BREAST_COVER_KEY", "censorBreastCover", "BREAST_LABELS", "coverFor"):
        if name not in src:
            raise AssertionError(f"缺少 {name}")
    i = src.find("const visibleBoxes")
    if "coverFor(b.label" not in src[i:i + 200]:
        raise AssertionError("visibleBoxes 必须按标签取缩放比，不能一律用 censorCover()")
    # 新增的偏好键要登记进 PREF_KEYS，否则「清空设置」清不掉
    j = src.find("const PREF_KEYS")
    seg = src[j:j + 400]
    for k in ("CENSOR_LABELS_KEY", "CENSOR_BREAST_COVER_KEY", "THUMB_PER_CELL_KEY"):
        if k not in seg:
            raise AssertionError(f"{k} 没登记进 PREF_KEYS，清空设置会留残留")


def test_censor_labels_are_configurable():
    """「遮哪些部位」必须可配，而且过滤留在前端 —— 改名单不该要求重新检测。

    实测本机 119 条检测缓存：显示 144 个框，而被这份名单挡掉的**高分**框有 357 个
    （FACE_FEMALE 138、ARMPITS_EXPOSED 63、FEMALE_BREAST_COVERED 57…）。
    用户「反复点重检结果都一样」的真正原因就在这里 ——
    不是检测不到，是检测到了被过滤掉了。写死名单等于把这些永久藏起来。
    """
    src = _mediabrowser_js()
    for name in ("CENSOR_LABEL_GROUPS", "CENSOR_LABELS_KEY", "censorLabels"):
        if name not in src:
            raise AssertionError(f"缺少 {name}")
    if "const CENSOR_LABELS = new Set" in src:
        raise AssertionError("名单仍然写死；应当改成 censorLabels() 读配置")
    i = src.find("const filterClientBoxes")
    if "censorLabels()" not in src[i:i + 260]:
        raise AssertionError("前端过滤必须走可配名单")
    # 后端存的下限要低于前端默认阈值，否则「调低灵敏度」根本没有框可放出来
    import censor
    assert censor.CACHE_FLOOR < 0.35, (
        f"CACHE_FLOOR={censor.CACHE_FLOOR} 不低于前端默认阈值，"
        "调低灵敏度时缓存里没有更多框可用")


def test_no_composed_strings_passed_to_t():
    """不许把拼出来的字符串送进 t()。

    t() 是整串精确查表：`t(`全部用 ${lab}`)` 拼出「全部用 512」，
    而词典里存的是带占位符的「全部用 {px}」—— 永远命中不了，
    英文界面下那几项就漏中文。**而且 test_every_t_key_has_english 抓不到**，
    它只扫源码里的字面量 t("...")，拼接出来的看不见。
    正确写法是 t("全部用 {px}", { px })。
    """
    src = _mediabrowser_js()
    # t(`...${...}...`) —— 模板串里带插值，必然是拼过的
    bad = re.findall(r"\bt\(\s*`[^`]*\$\{[^`]*`", src)
    if bad:
        raise AssertionError(f"这些 t() 收的是拼过的模板串: {[b[:60] for b in bad]}")
    # t(变量) 也危险，但变量名可能只是转发；只挡明显的拼接
    bad2 = re.findall(r"\bt\(\s*[\"'][^\"']*[\"']\s*\+", src)
    if bad2:
        raise AssertionError(f"这些 t() 收的是字符串拼接: {bad2[:3]}")


def test_thumb_presets_are_whole_profiles_not_flat_values():
    """预设必须是「一整套哪档配多大」，不是一刀切一个数。

    一刀切没意义：同一个数对小格子用不上、对大格子又不够。
    而且每套内部必须**格子越大给越高**，否则这个功能没有意义。
    """
    src = _mediabrowser_js()
    m = re.search(r"const THUMB_PRESETS = \{(.*?)\n\};", src, re.S)
    if not m:
        raise AssertionError("找不到 THUMB_PRESETS")
    body = m.group(1)
    names = re.findall(r"(\w+):\s*\{([^}]*)\}", body)
    assert len(names) >= 3, f"预设太少: {[n for n, _ in names]}"
    for name, tbl in names:
        pairs = {int(a): (0 if b == "THUMB_NATIVE_PX" else int(b))
                 for a, b in re.findall(r"(\d+):\s*(\d+|THUMB_NATIVE_PX)", tbl)}
        assert set(pairs) == {2, 3, 4, 5, 6}, f"{name} 没覆盖全部五档: {sorted(pairs)}"
        # 列数从多到少 = 格子从小到大，值必须单调不减（0 = 原像素，视为最大）
        seq = [pairs[c] if pairs[c] else 10 ** 9 for c in sorted(pairs, reverse=True)]
        assert seq == sorted(seq), f"{name} 不是「格子越大给越高」: {seq}"


def test_thumb_default_is_not_the_heaviest():
    """默认不能是最费的那档 —— 首次打开就卡会让人以为插件有问题。"""
    src = _mediabrowser_js()
    m = re.search(r'loadStr\(THUMB_PX_KEY,\s*"(\w[\w-]*)"\)', src)
    if not m:
        raise AssertionError("找不到默认模式")
    default = m.group(1)
    assert default != "max", "默认不该是最高档"
    assert default in ("balanced", "light"), f"默认是 {default}，应当是省流量或均衡"


def test_dpr_shown_is_rounded():
    """屏幕像素密度显示要取整 —— 1.65 倍屏上原始值是 1.6500000953674316。"""
    src = _mediabrowser_js()
    i = src.find("const dprRaw")
    if i < 0:
        raise AssertionError("应当把原始 DPR 和显示用的分开")
    seg = src[i:i + 260]
    if "Math.round" not in seg:
        raise AssertionError("显示用的 DPR 必须取整")
    # 算需要多少像素时要用**原始**值，取整只为显示
    j = src.find("const need = Math.round(cw *")
    assert "dprRaw" in src[j:j + 60], "算像素需求要用原始 DPR，不是显示用的那个"


def test_per_cell_thumb_map_is_what_you_set():
    """每个格子档位单独配分辨率，且**配多少就请求多少**（不做隐式换算）。

    原来是一条看不见的公式（cellW>340 给 768，否则 512），
    用户在设置里看不出自己那一档到底会拿到多大 —— 改成显式表格。
    """
    src = _mediabrowser_js()
    for name in ("THUMB_PER_CELL_KEY", "thumbPerCell", "THUMB_PX_VALUES"):
        if name not in src:
            raise AssertionError(f"缺少 {name}")
    i = src.find("const wantThumbPx")
    body = src[i:i + 400]
    if "thumbPerCell()" not in body:
        raise AssertionError("wantThumbPx 必须查每档表")
    if "devicePixelRatio" in body:
        raise AssertionError("请求时不该乘 DPR —— 表里配多少就请求多少，所见即所得")
    # 起始值必须随格子变大而变高，否则这个功能没意义
    seq = [_js_presets()["balanced"][c] for c in (6, 5, 4, 3, 2)]
    if seq != sorted(seq):
        raise AssertionError(f"起始值应随格子变大而单调不减，现在是 {seq}")
    # 设置界面要真把每档摆出来
    if "mb-percell" not in src:
        raise AssertionError("设置里缺少每档配置区")


def test_per_cell_does_not_guess_from_dpr():
    """别再按屏幕像素密度自动顶档。

    两个理由，缺一条都还能辩，两条一起就该删：
      ① 手机上格子本来就窄，DPR 高**不等于**这个格子要更多像素；
      ② 旧做法是「在阶梯上前进一格」，而档位表里一旦有值不在阶梯上
         （曾经的 640），indexOf 返回 -1 → 那一档被静默跳过，只有它不顶档。
    真正该看的是设置里那句「这块屏上约需 N 像素」，它按实际格子宽 × DPR 算。
    """
    src = _mediabrowser_js()
    for gone in ("thumbPerCellDefault", "THUMB_PER_CELL_BASE"):
        if gone in src:
            raise AssertionError(f"{gone} 应当已经删掉（按 DPR 顶档的老做法）")
    if "这块屏上约需 {need} 像素" not in src:
        raise AssertionError("删了自动顶档，就必须留着「这块屏约需多少像素」那句提示，"
                             "否则用户没有任何依据自己挑档")


def test_elapsed_from_png_info():
    """标准 prompt/workflow 没有耗时；有自定义键或 A1111 Time taken 才认。"""
    assert mb.elapsed_from_png_info({"prompt": "{}", "workflow": "{}"}) is None
    assert mb.elapsed_from_png_info({"generation_time": "12.5"}) == 12.5
    assert mb.elapsed_from_png_info({"elapsed": 0}) is None
    assert mb.elapsed_from_png_info({
        "parameters": "Steps: 20\nTime taken: 3.2s",
    }) == 3.2



def test_elapsed_from_status():
    """官方 101.09s 来自 history 起止时间戳，不在 PNG 里。"""
    assert mb.elapsed_from_status(None) is None
    assert mb.elapsed_from_status({"messages": []}) is None
    got = mb.elapsed_from_status({
        "messages": [
            ("execution_start", {"timestamp": 1_000_000}),
            ("execution_success", {"timestamp": 1_101_090}),
        ],
    })
    assert abs(got - 101.09) < 1e-6


def test_parse_ffmpeg_duration():
    assert mb.parse_ffmpeg_duration("Duration: 00:00:05.20, start: 0") == 5.2
    assert mb.parse_ffmpeg_duration("Duration: 00:01:05.00, bitrate:") == 65.0
    assert mb.parse_ffmpeg_duration("no duration here") is None


def test_history_elapsed_maps_output_rel():
    """history 按 type+subfolder/filename 对上，对不上的根目录不要误伤。"""
    class Q:
        def get_history(self):
            return {
                "pid": {
                    "status": {"messages": [
                        ("execution_start", {"timestamp": 1000}),
                        ("execution_success", {"timestamp": 3500}),
                    ]},
                    "outputs": {"9": {"images": [
                        {"filename": "a.png", "subfolder": "sub", "type": "output"},
                    ]}},
                }
            }
    inst = mb.PromptServer.instance
    inst.prompt_queue = Q()
    try:
        got = mb._history_elapsed_map("output")
        assert abs(got["sub/a.png"] - 2.5) < 1e-6
        assert mb._history_elapsed_map("input") == {}
    finally:
        del inst.prompt_queue


def test_history_elapsed_fallback_reads_only_recent_items():
    """目录列表的兼容兜底必须有界，不能随 ComfyUI 一万条 history 线性变慢。"""
    calls = []

    class Q:
        def get_history(self, max_items=None):
            calls.append(max_items)
            return {}

    inst = mb.PromptServer.instance
    inst.prompt_queue = Q()
    try:
        assert mb._history_elapsed_map("output") == {}
        assert len(calls) == 1
        assert isinstance(calls[0], int) and 0 < calls[0] <= 256
    finally:
        del inst.prompt_queue


def test_old_comfy_history_fallback_slices_internal_history():
    """旧版 get_history 不收参数时，也只能压取末尾小窗口，不能深拷贝整库。"""
    import threading

    history = {}
    for i in range(300):
        history[f"p{i}"] = {
            "status": {"messages": [
                ("execution_start", {"timestamp": 1_000}),
                ("execution_success", {"timestamp": 2_000}),
            ]},
            "outputs": {"9": {"images": [{
                "filename": f"{i}.png", "subfolder": "", "type": "output",
            }]}},
        }

    class OldQ:
        mutex = threading.RLock()

        def __init__(self):
            self.history = history

        def get_history(self):
            raise AssertionError("旧版兜底不应调用全量 get_history()")

    inst = mb.PromptServer.instance
    inst.prompt_queue = OldQ()
    try:
        got = mb._history_elapsed_map("output")
        assert len(got) == 128
        assert "299.png" in got and "172.png" in got
        assert "171.png" not in got and "0.png" not in got
    finally:
        del inst.prompt_queue


def test_old_comfy_history_fallback_keeps_latest_duplicate_path():
    """旧版尾部窗口仍要按时间正序应用，同一路径必须由最新任务覆盖。"""
    import threading

    def item(end):
        return {
            "status": {"messages": [
                ("execution_start", {"timestamp": 1_000}),
                ("execution_success", {"timestamp": end}),
            ]},
            "outputs": {"9": {"images": [{
                "filename": "same.png", "subfolder": "", "type": "output",
            }]}},
        }

    class OldQ:
        mutex = threading.RLock()
        history = {"older": item(2_000), "newer": item(4_000)}

        def get_history(self):
            raise AssertionError("应从受锁保护的内部 history 取有界窗口")

    inst = mb.PromptServer.instance
    inst.prompt_queue = OldQ()
    try:
        assert mb._history_elapsed_map("output")["same.png"] == 3.0
    finally:
        del inst.prompt_queue


def test_completion_hook_persists_elapsed_without_opening_browser():
    """生成完成就要落盘；不能再依赖用户先打开产物所在目录。

    这条同时把性能边界锁住：只读取刚完成的 prompt，并用 map_function 在
    ComfyUI 的 history 锁内提取小记录，不能复制最多一万条的完整历史。
    """
    import shutil
    import tempfile
    import threading
    import time

    td = tempfile.mkdtemp()
    output = os.path.join(td, "output")
    os.makedirs(os.path.join(output, "sub"))
    media = os.path.join(output, "sub", "a.png")
    with open(media, "wb") as f:
        f.write(b"generated-media")

    class Q:
        def __init__(self):
            self.mutex = threading.RLock()
            self.currently_running = {
                7: (0, "prompt-1", {}, {}, [], {}),
            }
            self.history = {}
            self.full_history_reads = 0

        def task_done(self, item_id, history_result, status, process_item=None):
            with self.mutex:
                prompt = self.currently_running.pop(item_id)
                self.history[prompt[1]] = {
                    "prompt": prompt,
                    "outputs": {},
                    "status": status,
                    **history_result,
                }
            return "original-result"

        def get_history(self, prompt_id=None, max_items=None, offset=-1,
                        map_function=None):
            if prompt_id is None:
                self.full_history_reads += 1
                raise AssertionError("完成采集不能读取整份 history")
            if map_function is None:
                raise AssertionError("完成采集不能深拷贝完整 prompt 记录")
            with self.mutex:
                return {prompt_id: map_function(self.history[prompt_id])}

    q = Q()
    inst = mb.PromptServer.instance
    had_queue = hasattr(inst, "prompt_queue")
    old_queue = getattr(inst, "prompt_queue", None)
    old_output = mb._DIRS["output"]
    old_index = mb.ELAPSED_INDEX
    old_elapsed = mb._ELAPSED
    old_dirty = mb._ELAPSED_DIRTY
    mb._DIRS["output"] = lambda: output
    mb.ELAPSED_INDEX = os.path.join(td, "_elapsed.json")
    mb._ELAPSED = {}
    mb._ELAPSED_DIRTY = False
    inst.prompt_queue = q
    try:
        assert mb._install_elapsed_completion_hook() is True
        got = q.task_done(7, {
            "outputs": {"9": {"images": [{
                "filename": "a.png", "subfolder": "sub", "type": "output",
            }]}},
        }, {"messages": [
            ("execution_start", {"timestamp": 1_000}),
            ("execution_success", {"timestamp": 5_250}),
        ]})
        assert got == "original-result", "挂钩不能改变 ComfyUI task_done 的返回值"

        deadline = time.monotonic() + 2.0
        while not os.path.isfile(mb.ELAPSED_INDEX) and time.monotonic() < deadline:
            time.sleep(0.01)
        with open(mb.ELAPSED_INDEX, encoding="utf-8") as f:
            saved = json.load(f)
        st = os.stat(media)
        assert saved[f"{st.st_size}|{st.st_mtime_ns}"] == 4.25
        assert q.full_history_reads == 0
    finally:
        if had_queue:
            inst.prompt_queue = old_queue
        else:
            del inst.prompt_queue
        mb._DIRS["output"] = old_output
        mb.ELAPSED_INDEX = old_index
        mb._ELAPSED = old_elapsed
        mb._ELAPSED_DIRTY = old_dirty
        shutil.rmtree(td, ignore_errors=True)


def test_completion_hook_never_breaks_task_done_during_shutdown():
    """解释器关机时线程池会拒绝 submit，但这不能让已经完成的生成变成报错。"""
    import threading

    class Q:
        def __init__(self):
            self.mutex = threading.RLock()
            self.currently_running = {1: (0, "prompt-shutdown")}
            self.history = {}

        def task_done(self, item_id, history_result, status, process_item=None):
            prompt = self.currently_running.pop(item_id)
            self.history[prompt[1]] = {"status": status, **history_result}
            return "generation-finished"

        def get_history(self, prompt_id=None, map_function=None, **_kwargs):
            return {prompt_id: map_function(self.history[prompt_id])}

    class ClosedPool:
        def submit(self, *_args, **_kwargs):
            raise RuntimeError("cannot schedule new futures after shutdown")

    q = Q()
    inst = mb.PromptServer.instance
    had_queue = hasattr(inst, "prompt_queue")
    old_queue = getattr(inst, "prompt_queue", None)
    old_pool = mb._ELAPSED_POOL
    inst.prompt_queue = q
    mb._ELAPSED_POOL = ClosedPool()
    try:
        assert mb._install_elapsed_completion_hook() is True
        got = q.task_done(1, {"outputs": {"9": {"images": [{
            "filename": "a.png", "subfolder": "", "type": "output",
        }]}}}, {"messages": [
            ("execution_start", {"timestamp": 1_000}),
            ("execution_success", {"timestamp": 2_000}),
        ]})
        assert got == "generation-finished"
        assert "prompt-shutdown" in q.history
    finally:
        mb._ELAPSED_POOL = old_pool
        if had_queue:
            inst.prompt_queue = old_queue
        else:
            del inst.prompt_queue


def test_completion_hook_ignores_malformed_custom_output():
    """第三方节点即使返回不可哈希的 type，辅助采集也不能污染 task_done。"""
    import threading

    class Q:
        def __init__(self):
            self.mutex = threading.RLock()
            self.currently_running = {2: (0, "prompt-malformed")}
            self.history = {}

        def task_done(self, item_id, history_result, status, process_item=None):
            prompt = self.currently_running.pop(item_id)
            self.history[prompt[1]] = {"status": status, **history_result}
            return "kept"

        def get_history(self, prompt_id=None, map_function=None, **_kwargs):
            item = self.history[prompt_id]
            return {prompt_id: map_function(item) if map_function else item}

    q = Q()
    inst = mb.PromptServer.instance
    had_queue = hasattr(inst, "prompt_queue")
    old_queue = getattr(inst, "prompt_queue", None)
    inst.prompt_queue = q
    try:
        assert mb._install_elapsed_completion_hook() is True
        got = q.task_done(2, {"outputs": {"custom": {"files": [{
            "filename": "a.png", "subfolder": "", "type": ["output"],
        }]}}}, {"messages": [
            ("execution_start", {"timestamp": 1_000}),
            ("execution_success", {"timestamp": 2_000}),
        ]})
        assert got == "kept"
        assert "prompt-malformed" in q.history
    finally:
        if had_queue:
            inst.prompt_queue = old_queue
        else:
            del inst.prompt_queue


def test_elapsed_write_queued_before_purge_cannot_restore_index():
    """全缓存清理完成后，清理前排队的后台任务不能把旧耗时重新写回来。"""
    import shutil
    import tempfile

    td = tempfile.mkdtemp()
    output = os.path.join(td, "output")
    cache = os.path.join(td, "cache")
    regions = os.path.join(td, "regions")
    os.makedirs(output)
    os.makedirs(cache)
    os.makedirs(regions)
    media = os.path.join(output, "a.png")
    with open(media, "wb") as f:
        f.write(b"finished-before-purge")

    old_values = (
        mb.CACHE_DIR, mb.DIM_INDEX, mb.ELAPSED_INDEX, mb.REGIONS_DIR,
        mb._DIRS["output"], mb._ELAPSED, mb._ELAPSED_DIRTY,
        mb._ELAPSED_EPOCH,
    )
    mb.CACHE_DIR = cache
    mb.DIM_INDEX = os.path.join(cache, "_dims.json")
    mb.ELAPSED_INDEX = os.path.join(cache, "_elapsed.json")
    mb.REGIONS_DIR = regions
    mb._DIRS["output"] = lambda: output
    mb._ELAPSED = {}
    mb._ELAPSED_DIRTY = False
    try:
        queued_epoch = mb._ELAPSED_EPOCH
        mb._purge_what("disk")
        mb._persist_elapsed_records([("output", "a.png", 3.5)], queued_epoch)
        assert mb._ELAPSED == {}
        assert not os.path.exists(mb.ELAPSED_INDEX)
    finally:
        (mb.CACHE_DIR, mb.DIM_INDEX, mb.ELAPSED_INDEX, mb.REGIONS_DIR,
         mb._DIRS["output"], mb._ELAPSED, mb._ELAPSED_DIRTY,
         mb._ELAPSED_EPOCH) = old_values
        shutil.rmtree(td, ignore_errors=True)


def test_clipinfo_rejects_traversal():
    """片长接口也必须走 _resolve，不能拿任意路径去开 ffmpeg。"""
    import asyncio
    r = asyncio.run(mb.mediabrowser_clipinfo(_post({
        "type": "output",
        "files": ["../secret.mp4", "C:/Windows/a.mp4"],
    })))
    assert r.status == 200
    raw = r.body
    body = json.loads(raw.decode("utf-8")) if isinstance(raw, (bytes, bytearray)) else raw
    assert body.get("duration") == {}


# ── 5. 遮蔽：纯函数（不装 onnxruntime 也必须能跑）──
def test_censor_import_without_ort():
    import censor as cz
    assert cz.INPUT_SIZE == 640
    assert "FEMALE_BREAST_EXPOSED" in cz.DEFAULT_BLUR
    assert "FACE_FEMALE" not in cz.DEFAULT_BLUR
    assert "FEET_EXPOSED" not in cz.DEFAULT_BLUR


def test_censor_file_sha256_matches_stdlib():
    import hashlib
    import tempfile
    import censor as cz
    raw = b"mediabrowser-weight-fixture"
    fd, path = tempfile.mkstemp(suffix=".bin")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(raw)
        assert cz.file_sha256(path) == hashlib.sha256(raw).hexdigest()
    finally:
        os.remove(path)


def test_censor_download_rejects_github_login_html():
    """GitHub 对这个仓会返回登录页 HTML，不能当成权重。"""
    import censor as cz
    html = b"<!DOCTYPE html>\n<html lang=\"en\" class=\"html-auth\">"
    assert cz.looks_like_html(html, "text/html; charset=utf-8")
    assert cz.looks_like_html(b"\n\n<!DOCTYPE html>\n<html", "")
    assert not cz.looks_like_html(b"\x08\t\x12\x07pytorch", "application/octet-stream")


def test_censor_cache_key_changes_with_mtime_and_model():
    import censor as cz
    a = cz.cache_key("/x.png", 1000, 50, "nudenet-640m", 98)
    b = cz.cache_key("/x.png", 1001, 50, "nudenet-640m", 98)
    c = cz.cache_key("/x.png", 1000, 50, "custom", 98)
    assert a != b and a != c


def test_censor_nms_keeps_higher_score():
    import censor as cz
    boxes = [(0, 0, 10, 10), (1, 1, 10, 10), (50, 50, 8, 8)]
    scores = [0.9, 0.4, 0.8]
    keep = cz.nms(boxes, scores, iou_thr=0.45)
    assert keep == [0, 2]


def test_box_filtering_lives_in_frontend_only():
    """框的过滤（阈值 + 部位）只有前端一份实现，Python 侧不许留影子。

    原来 censor.py 有个 filter_boxes，**生产代码一次都没调用**，只有这条测试在测它 ——
    JS 那边写反照样全绿。跟之前 annotate 的坑是同一个：
    测试打在没人用的 Python 影子实现上，等于没测。
    后端的职责只有一个：把 CACHE_FLOOR 以上的框**原样存下来**，
    要显示哪些由前端按当前设置决定（所以改阈值/部位才能瞬时生效、不用重检）。
    """
    import censor as cz
    if hasattr(cz, "filter_boxes"):
        raise AssertionError(
            "censor.filter_boxes 是没人调的影子实现；过滤在前端 filterClientBoxes。"
            "留着它只会让人以为后端也在过滤")
    src = _mediabrowser_js()
    i = src.find("const filterClientBoxes")
    body = src[i:i + 320]
    for need in ("thr", "labs"):
        if need not in body:
            raise AssertionError(f"filterClientBoxes 应当同时按阈值和部位过滤（缺 {need}）")
    # 后端存的下限必须低于前端默认阈值，否则「放宽灵敏度」没有框可放出来
    assert cz.CACHE_FLOOR < 0.35


def test_censor_yolo_xywh_to_rel_matches_nudenet_pad():
    """NudeNet：先 pad 到 max(w,h) 的右/下，再缩到 640。坐标还原必须对齐。"""
    import censor as cz
    rel = cz.yolo_to_rel(
        cx=160, cy=320, w=80, h=80,
        orig_w=320, orig_h=640, model=640, x_pad=320, y_pad=0,
    )
    assert abs(rel["x"] - 120 / 320) < 1e-4
    assert abs(rel["y"] - 280 / 640) < 1e-4
    assert abs(rel["w"] - 80 / 320) < 1e-4


def _req(**q):
    return types.SimpleNamespace(rel_url=types.SimpleNamespace(query=q))


def _post(body):
    async def json():
        return body
    return types.SimpleNamespace(json=json)


def test_regions_missing_filename_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_regions(_req(type="output")))
    assert r.status == 400


def test_regions_traversal_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_regions(_req(filename="../secret.png", type="output")))
    assert r.status == 400


def test_regions_audio_unsupported():
    import asyncio
    r = asyncio.run(mb.mediabrowser_regions(
        _req(filename="nope.wav", type="input", infer="0")))
    assert r.status in (400, 404)


def test_plugin_import_does_not_need_ort():
    assert hasattr(mb, "mediabrowser_regions")
    assert hasattr(mb, "mediabrowser_censor_status")


def test_censor_relative_onnx_stays_in_models_dir():
    """相对路径只取文件名，拼到 _models/，不能靠 ../ 跳出。"""
    import censor as cz
    os.makedirs(cz.MODELS_DIR, exist_ok=True)
    dummy = os.path.join(cz.MODELS_DIR, "escape.onnx")
    with open(dummy, "wb") as f:
        f.write(b"onnx")
    try:
        got = cz._resolve_onnx_path("../escape.onnx")
        assert os.path.normcase(got) == os.path.normcase(dummy), got
        assert os.path.normcase(got).startswith(os.path.normcase(cz.MODELS_DIR)), got
    finally:
        os.remove(dummy)


def test_recommended_present_rejects_tiny_file():
    """登录页 HTML 只有几 KB，不能当成已装的 640m。"""
    import shutil
    import tempfile
    import censor as cz
    td = tempfile.mkdtemp()
    old = cz.MODELS_DIR
    cz.MODELS_DIR = td
    try:
        with open(os.path.join(td, cz.WEIGHT_NAME), "wb") as f:
            f.write(b"<!doctype html>")
        assert cz.recommended_present() is False
        assert cz.recommended_ready() is False
    finally:
        cz.MODELS_DIR = old
        shutil.rmtree(td, ignore_errors=True)


def test_download_start_skips_when_ready():
    import censor as cz
    cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)
    old = cz.recommended_ready
    cz.recommended_ready = lambda: True
    try:
        r = cz.download_start()
        assert r["started"] is False
        assert r.get("has_recommended") is True
        assert cz._dl["on"] is False
    finally:
        cz.recommended_ready = old


def test_download_start_already_on_does_not_double():
    import censor as cz
    cz._dl.update(on=True, progress=0.2, error=None, cancel=False, cancelled=False)
    try:
        r = cz.download_start(force=True)
        assert r["started"] is False
        assert r.get("downloading") is True
    finally:
        cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)


def test_download_cancel_is_not_error():
    import censor as cz
    cz._dl.update(on=True, progress=0.3, error="下到的是网页", cancel=False, cancelled=False)
    try:
        cz.download_cancel()
        assert cz._dl["cancel"] is True
        cz._finish_download(cancelled=True)
        assert cz._dl["on"] is False
        assert cz._dl["error"] is None
        assert cz._dl["cancelled"] is True
        st = cz.status()
        assert st["cancelled"] is True
        assert st["error"] is None
    finally:
        cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)


def test_download_worker_cancel_before_url():
    """worker 看见取消必须清 error，不能把上一轮失败留下来。"""
    import censor as cz
    cz._dl.update(on=True, progress=0.1, error="下到的是网页", cancel=True, cancelled=False)
    try:
        cz._download_worker()
        assert cz._dl["on"] is False
        assert cz._dl["error"] is None
        assert cz._dl["cancelled"] is True
    finally:
        cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)


def test_download_start_force_starts_when_ready():
    import threading
    import censor as cz
    cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)
    old_ready = cz.recommended_ready
    old_thread = threading.Thread
    n = {"n": 0}

    class _Fake:
        def __init__(self, *a, **k):
            pass
        def start(self):
            n["n"] += 1

    cz.recommended_ready = lambda: True
    threading.Thread = _Fake
    try:
        r = cz.download_start(force=True)
        assert r["started"] is True
        assert n["n"] == 1
        assert cz._dl["on"] is True
    finally:
        cz.recommended_ready = old_ready
        threading.Thread = old_thread
        cz._dl.update(on=False, progress=0.0, error=None, cancel=False, cancelled=False)


def test_infer_zero_does_not_load_session():
    """打开浏览读缓存不得 load ONNX session。"""
    import censor as cz
    from PIL import Image
    cz.shutdown()
    tmp = os.path.join(os.path.dirname(__file__), "_tmp_censor.png")
    Image.new("RGB", (8, 8), (9, 8, 7)).save(tmp)
    try:
        r = cz.detect_file(tmp, infer=False)
        assert r.get("reason") == "no_cache", r
        assert cz._session is None
    finally:
        os.remove(tmp)


def test_trash_missing_filename_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_trash(_post({})))
    assert r.status == 400


def test_trash_traversal_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_trash(_post({
        "type": "output", "filename": "../secret.png",
    })))
    assert r.status == 400


def test_trash_absolute_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_trash(_post({
        "type": "output", "filename": r"C:\Windows\win.ini",
    })))
    assert r.status == 400


def test_trash_missing_file_404():
    import asyncio
    r = asyncio.run(mb.mediabrowser_trash(_post({
        "type": "output", "filename": "no-such-mb-trash.png",
    })))
    assert r.status == 404


def test_trash_directory_400():
    import asyncio
    root = mb._DIRS["output"]()
    os.makedirs(os.path.join(root, "_mb_dir"), exist_ok=True)
    r = asyncio.run(mb.mediabrowser_trash(_post({
        "type": "output", "filename": "_mb_dir",
    })))
    assert r.status == 400


def _list_body(resp):
    raw = resp.body
    return json.loads(raw.decode("utf-8")) if isinstance(raw, (bytes, bytearray)) else raw


def test_list_refresh_bypasses_ttl_cache():
    """点刷新必须重扫盘。20 秒 TTL 只挡连点，不能把手动刷新也吞成旧列表。"""
    import asyncio
    import shutil
    import tempfile
    import time
    td = tempfile.mkdtemp()
    idxd = tempfile.mkdtemp()
    old = mb._DIRS["output"]
    old_dims, old_idx, old_dirty = mb._DIMS, mb.DIM_INDEX, mb._DIMS_DIRTY
    mb._DIRS["output"] = lambda: td
    mb._DIMS = {}
    mb.DIM_INDEX = os.path.join(idxd, "_dims.json")
    mb._DIMS_DIRTY = False
    try:
        with open(os.path.join(td, "fresh.png"), "wb") as f:
            f.write(b"x")
        mb._LIST_CACHE["output||0"] = (time.time(), {
            "dirs": [],
            "files": [{"p": "stale.png", "t": 1, "a": os.path.join(td, "stale.png")}],
        })
        cached = _list_body(asyncio.run(mb.mediabrowser_list(_req(type="output"))))
        assert cached.get("cached") is True
        assert cached.get("files") == ["stale.png"]

        fresh = _list_body(asyncio.run(mb.mediabrowser_list(
            _req(type="output", refresh="1"))))
        assert fresh.get("cached") is False
        assert fresh.get("files") == ["fresh.png"]

        again = _list_body(asyncio.run(mb.mediabrowser_list(_req(type="output"))))
        assert again.get("files") == ["fresh.png"]
    finally:
        mb._DIRS["output"] = old
        mb._DIMS = old_dims
        mb.DIM_INDEX = old_idx
        mb._DIMS_DIRTY = old_dirty
        mb._LIST_CACHE.pop("output||0", None)
        shutil.rmtree(td, ignore_errors=True)
        shutil.rmtree(idxd, ignore_errors=True)


def test_trash_ok_and_clears_list_cache():
    """路由必须先 _resolve，成功后清掉该根的列表缓存。回收站本身用替身，避免测试往回收站扔垃圾。"""
    import asyncio
    root = mb._DIRS["output"]()
    os.makedirs(root, exist_ok=True)
    rel = "_mb_trash_ok.txt"
    path = os.path.join(root, rel)
    with open(path, "w", encoding="utf-8") as f:
        f.write("x")
    mb._LIST_CACHE[f"output||0"] = (0.0, {"dirs": [], "files": []})
    seen = []

    def fake(p):
        seen.append(p)
        assert os.path.isfile(p)

    old = mb._send_to_recycle
    mb._send_to_recycle = fake
    try:
        r = asyncio.run(mb.mediabrowser_trash(_post({
            "type": "output", "filename": rel,
        })))
        assert r.status == 200, getattr(r, "text", r)
        assert seen and os.path.normcase(seen[0]) == os.path.normcase(path)
        assert not any(k.startswith("output|") for k in mb._LIST_CACHE)
    finally:
        mb._send_to_recycle = old
        if os.path.isfile(path):
            os.remove(path)


def test_send_to_recycle_windows_moves_file():
    """真的走 SHFileOperation。只在 Windows 跑，会在回收站留一个探测文件。"""
    if os.name != "nt":
        return
    root = mb._DIRS["output"]()
    os.makedirs(root, exist_ok=True)
    path = os.path.join(root, "_mb_recycle_probe.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("probe")
    mb._send_to_recycle(path)
    assert not os.path.isfile(path), "文件还在原处，回收站没接住"


def test_purge_unknown_400():
    import asyncio
    r = asyncio.run(mb.mediabrowser_purge(_post({"what": "nope"})))
    assert r.status == 400
    r = asyncio.run(mb.mediabrowser_purge(_post({"what": "../secret"})))
    assert r.status == 400


def test_purge_thumbs_keeps_dims_index():
    import asyncio
    import shutil
    import tempfile
    td = tempfile.mkdtemp()
    old_c, old_d = mb.CACHE_DIR, mb.DIM_INDEX
    mb.CACHE_DIR = td
    mb.DIM_INDEX = os.path.join(td, "_dims.json")
    try:
        open(os.path.join(td, "a.webp"), "w", encoding="utf-8").write("x")
        open(os.path.join(td, "_dims.json"), "w", encoding="utf-8").write("{}")
        mb._LIST_CACHE["output||0"] = (0.0, {"dirs": [], "files": []})
        r = asyncio.run(mb.mediabrowser_purge(_post({"what": "thumbs"})))
        assert r.status == 200, getattr(r, "text", r)
        assert not os.path.isfile(os.path.join(td, "a.webp"))
        assert os.path.isfile(os.path.join(td, "_dims.json"))
        assert mb._LIST_CACHE == {}
    finally:
        mb.CACHE_DIR = old_c
        mb.DIM_INDEX = old_d
        shutil.rmtree(td, ignore_errors=True)


def test_purge_disk_clears_index_and_regions():
    import asyncio
    import shutil
    import tempfile
    td = tempfile.mkdtemp()
    rd = tempfile.mkdtemp()
    old_c, old_d, old_r = mb.CACHE_DIR, mb.DIM_INDEX, mb.REGIONS_DIR
    mb.CACHE_DIR = td
    mb.DIM_INDEX = os.path.join(td, "_dims.json")
    mb.REGIONS_DIR = rd
    try:
        open(os.path.join(td, "a.webp"), "w", encoding="utf-8").write("x")
        open(os.path.join(td, "_dims.json"), "w", encoding="utf-8").write("{}")
        open(os.path.join(rd, "box.json"), "w", encoding="utf-8").write("{}")
        mb._DIMS["p"] = [1, 2, 0]
        r = asyncio.run(mb.mediabrowser_purge(_post({"what": "disk"})))
        assert r.status == 200
        assert not os.path.isfile(os.path.join(td, "a.webp"))
        assert not os.path.isfile(os.path.join(td, "_dims.json"))
        assert not os.path.isfile(os.path.join(rd, "box.json"))
        assert mb._DIMS == {}
    finally:
        mb.CACHE_DIR = old_c
        mb.DIM_INDEX = old_d
        mb.REGIONS_DIR = old_r
        shutil.rmtree(td, ignore_errors=True)
        shutil.rmtree(rd, ignore_errors=True)


def _init_py():
    return open(os.path.join(os.path.dirname(_web_dir()), "__init__.py"),
                encoding="utf-8").read()


def _web_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web")


def _mediabrowser_js():
    return open(os.path.join(_web_dir(), "mediabrowser.js"), encoding="utf-8").read()


def test_browse_reattaches_upload_loaders():
    """标题改过的加载器不能只靠 NODE_SPECS[class]；gallery 能挂就要能挂浏览。"""
    src = _mediabrowser_js()
    if "const specFor =" not in src:
        raise AssertionError("缺少 specFor，改名加载器会丢浏览按钮")
    if "_origUploadFlag" not in src:
        raise AssertionError("要认 gallery 拆掉的 image_upload 标记")
    if "serialize: false" not in src:
        raise AssertionError("浏览按钮必须 serialize:false，否则 configure 会冲掉")
    if "LoadImageGoohai" not in src:
        raise AssertionError("孤海加载图像要进适配表")
    if "function placeBrowseButton" not in src:
        raise AssertionError("按钮必须插到预览前面，不能只 addWidget 追加")
    setup_i = src.find("setup() {")
    if setup_i < 0 or "attachButton(n)" not in src[setup_i:setup_i + 180]:
        raise AssertionError("setup 必须扫一遍已有节点")
    attach_i = src.find("function attachButton")
    if attach_i < 0 or "onConfigure" not in src[attach_i:attach_i + 900]:
        raise AssertionError("configure 之后要再挂一次按钮")
    attach = src[attach_i:attach_i + 500]
    hook_i = attach.find("_mbCfgHook")
    spec_i = attach.find("if (!spec) return")
    if hook_i < 0 or spec_i < 0 or hook_i > spec_i:
        raise AssertionError("spec 为空也要先挂 onConfigure，否则后补 widgets 的加载器会丢浏览")


def test_hexie_cell_acts_not_gated_on_local_mode():
    """⟳ / 跳过河蟹跟锁一样，不跟「局部」档位绑死。"""
    src = _mediabrowser_js()
    i = src.find("attachRedoBtn(c,")
    if i < 0:
        raise AssertionError("宫格必须挂 attachRedoBtn")
    before = src[max(0, i - 220):i]
    if 'reason === "failed"' not in before:
        raise AssertionError("宫格重检角标必须只在上次失败时挂")
    if 'censorMode === "local"' in before:
        raise AssertionError("宫格河蟹钮仍绑在「局部」档位上")
    if "attachSkipBtn(c," not in src[i:i + 180]:
        raise AssertionError("宫格必须挂 attachSkipBtn")
    gated_viewer = 'redoBtn.style.display = (hooks.getMode?.() ?? "off") === "local" ? "" : "none"'
    if gated_viewer in src:
        raise AssertionError("放大预览的重新检测钮仍只在「局部」下显示")


def test_sel_tag_yields_to_detecting_spinner():
    """选中「当前」和检测转圈不能抢同一个无条件 ::after。"""
    src = _mediabrowser_js()
    if ".mb-cell.sel:not(.detecting)::after" not in src:
        raise AssertionError("选中标必须写成 .mb-cell.sel:not(.detecting)::after")
    if ".mb-cell.detecting::after" not in src:
        raise AssertionError("检测转圈必须继续用 .mb-cell.detecting::after")
    if ".mb-cell.sel::after{" in src or ".mb-cell.sel::after {" in src:
        raise AssertionError("无条件 .mb-cell.sel::after 会盖掉检测转圈")


def test_sel_tag_not_on_redo_corner():
    """「当前」离开顶边，把四角留给锁/眼/跳过/重检。"""
    src = _mediabrowser_js()
    i = src.find(".mb-cell.sel:not(.detecting)::after")
    if i < 0:
        raise AssertionError("找不到选中标规则")
    block = src[i:i + 320]
    if "right:3px" in block:
        raise AssertionError("选中标仍在 right:3px，会和 .mb-redo 叠在一起")
    if "left:50%" in block or "translateX(-50%)" in block:
        raise AssertionError("选中标不应再占顶边正中，小格子会和角钮挤在一起")
    if "bottom:" not in block:
        raise AssertionError("选中标应落在文件名上方")


def test_redo_glyph_differs_from_dir_refresh():
    """目录刷新、单张重检、设置标题不能共用同一个箭头。"""
    src = _mediabrowser_js()
    i = src.find("const attachRedoBtn")
    if i < 0:
        raise AssertionError("找不到 attachRedoBtn")
    if "lucide--refresh-cw" in src[i:i + 420]:
        raise AssertionError("单张重检不能再用目录刷新那个箭头")
    if 'data-act="refresh"' not in src or "lucide--refresh-cw" not in src:
        raise AssertionError("目录刷新应继续用 refresh-cw")
    if 'lucide--refresh-cw")} ${escHtml(t("推荐模型' in src:
        raise AssertionError("推荐模型标题不要再用刷新箭头")


def test_skip_state_is_icon_not_extra_badge():
    """已跳过由右上角钮常显，不再叠一个「跳过」角标去挤小格子。"""
    src = _mediabrowser_js()
    if 'badges.push(`<span class="skip">' in src:
        raise AssertionError("paint 不应再往角标里塞跳过")
    if 'bd.insertAdjacentHTML("beforeend", `<span class="skip">' in src:
        raise AssertionError("paintSkipOnCell 不应再补跳过角标")


def test_viewer_has_lock_and_skip_acts():
    """放大预览底栏要有锁和跳过，并且接到宫格同一套 helper。"""
    src = _mediabrowser_js()
    if 'class="act lock"' not in src:
        raise AssertionError("放大预览缺少锁按钮")
    if 'class="act skip"' not in src:
        raise AssertionError("放大预览缺少跳过按钮")
    if "toggleMark: setLockOnPath" not in src:
        raise AssertionError("查看器必须把 toggleMark 接到 setLockOnPath")
    if "toggleSkip: setSkipOnPath" not in src:
        raise AssertionError("查看器必须把 toggleSkip 接到 setSkipOnPath")


def test_viewer_peek_resets_and_respects_skip():
    src = _mediabrowser_js()
    show_i = src.find("const show = () => {")
    if show_i < 0:
        raise AssertionError("找不到查看器 show()")
    show = src[show_i:show_i + 900]
    if 'stage.classList.remove("peeking")' not in show:
        raise AssertionError("翻页必须清掉上一张的揭开态")
    peek_i = src.find("const viewerCanPeek = () => {")
    if peek_i < 0:
        raise AssertionError("找不到 viewerCanPeek")
    if 'mode === "local" && !hooks.isSkipDetect' not in src[peek_i:peek_i + 320]:
        raise AssertionError("已跳过的图在局部下不该还能 peek")
    skip_click = src.find('lay.querySelector(".skip").onclick')
    if skip_click < 0:
        raise AssertionError("找不到查看器 skip 点击")
    skip_fn = src[skip_click:skip_click + 280]
    if 'stage.classList.remove("peeking")' not in skip_fn:
        raise AssertionError("查看器点跳过必须清 peek，对齐锁")


def test_unlock_keeps_local_peek():
    """局部有框时解锁不能把揭开钮拆掉。"""
    src = _mediabrowser_js()
    i = src.find("const paintLockOnCell")
    if i < 0:
        raise AssertionError("找不到 paintLockOnCell")
    if "needsPeek(path)" not in src[i:i + 480]:
        raise AssertionError("解锁后局部有框应重新挂揭开钮")


def test_viewer_redo_uses_scan_ico():
    """查看器重检必须跟宫格一样用取景框，不能退回 refresh-cw。"""
    src = _mediabrowser_js()
    i = src.find('class="act redo"')
    if i < 0:
        raise AssertionError("找不到查看器 redo")
    chunk = src[i:i + 180]
    if "lucide--refresh-cw" in chunk:
        raise AssertionError("查看器重检不能用目录刷新那个箭头")
    if "mbScanIco()" not in chunk:
        raise AssertionError("查看器重检应走 mbScanIco")


def test_js_templates_are_joined():
    """用 node 真 parse；node --check 对 ESM import 抓不到 Unexpected token。"""
    import subprocess
    import tempfile
    from pathlib import Path

    src = _mediabrowser_js()
    if 't(`遮蔽接口返回 HTTP ${' in src:
        raise AssertionError("HTTP 状态必须走 {status} 占位，不能先插值再查表")
    stub = src.replace(
        'import { app } from "../../scripts/app.js";',
        "const app = { registerExtension() {} };",
    )
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".js", delete=False) as f:
        f.write(stub)
        path = f.name
    try:
        uri = Path(path).resolve().as_uri()
        r = subprocess.run(
            ["node", "--input-type=module", "-e", f"import '{uri}'"],
            capture_output=True, text=True,
        )
        err = (r.stderr or "") + (r.stdout or "")
        if "Unexpected token" in err or "SyntaxError" in err:
            raise AssertionError(err[:600])
    except FileNotFoundError:
        pass
    finally:
        os.remove(path)


def test_ensure_local_paints_overlay_only_in_local_mode():
    """查看器重检不得在原图/全幅下往格子上画框。"""
    src = _mediabrowser_js()
    if 'if (censorMode === "local" && rec.boxes && !isMarked(path)' not in src:
        raise AssertionError("ensureLocal 必须先看是不是局部再 paintCensorOverlay")


def test_skip_hugs_corner_when_redo_absent():
    """重检不再常挂，跳过要贴右上角；只有重检真出现才让一格。"""
    src = _mediabrowser_js()
    # 专指定位规则。共享那条 `.mb-redo,.mb-skip{position…top:3px}` 也会命中
    # `.mb-skip{`，不能拿它当「贴右边」的证据。
    i = src.find(".mb-cell .mb-skip{right:")
    if i < 0:
        raise AssertionError("找不到 .mb-cell .mb-skip 的 right 定位")
    decl = src[i:src.find("}", i)].replace(" ", "")
    if "right:3px" not in decl:
        raise AssertionError("跳过默认应 right:3px，贴右上角")
    if "right:calc(" in decl:
        raise AssertionError("跳过还在给已撤的重检留位子")
    yield_i = src.find(".mb-cell:has(.mb-redo) .mb-skip{")
    if yield_i < 0:
        raise AssertionError("重检真挂上时，跳过要让出右上角那一格")
    yield_decl = src[yield_i:src.find("}", yield_i)].replace(" ", "")
    if "right:calc(3px+var(--mb-peek,26px)+3px)" not in yield_decl:
        raise AssertionError("让位距离应对齐一枚角钮加缝")


def test_redo_btn_unmounts_when_no_longer_failed():
    """重检不再失败时必须卸掉角标，否则 :has(.mb-redo) 会让跳过继续缩进。"""
    src = _mediabrowser_js()
    if "const detachRedoBtn" not in src:
        raise AssertionError("必须有 detachRedoBtn")
    if 'querySelector(".mb-redo")?.remove()' not in src:
        raise AssertionError("detachRedoBtn 必须真的卸掉 .mb-redo")
    sync_i = src.find("const syncRedoOnCell")
    if sync_i < 0:
        raise AssertionError("格子上的重检角标必须走 syncRedoOnCell，跟 regionMem.reason 对齐")
    sync = src[sync_i:sync_i + 420]
    if 'reason === "failed"' not in sync:
        raise AssertionError("syncRedoOnCell 只应在 failed 时挂")
    if "detachRedoBtn" not in sync:
        raise AssertionError("不再 failed 时 syncRedoOnCell 必须卸")
    redo_i = src.find("const redoOne = async")
    if redo_i < 0:
        raise AssertionError("找不到 redoOne")
    if "syncRedoOnCell(el, path)" not in src[redo_i:redo_i + 900]:
        raise AssertionError("redoOne 结束后必须 sync 角标，成功后跳过才能贴回右上角")


def test_skip_on_stays_visible_like_lock():
    """已跳过跟已锁一样常显；触屏闲置只收未激活的跳过。"""
    src = _mediabrowser_js()
    if ".mb-cell .mb-skip.on{" not in src and ".mb-cell .mb-skip.on {" not in src:
        raise AssertionError("缺少 .mb-skip.on 样式")
    on_i = src.find(".mb-cell .mb-skip.on{")
    if on_i < 0:
        on_i = src.find(".mb-cell .mb-skip.on {")
    on_block = src[on_i:on_i + 160]
    if "opacity:1" not in on_block.replace(" ", ""):
        raise AssertionError("已跳过必须 opacity:1，不能只靠 hover")
    if ".mb-box.touching.bars-idle .mb-cell .mb-skip:not(.on)" not in src:
        raise AssertionError("触屏闲置应收未跳过的钮，已跳过要留下")


def _mb_en_dict(src):
    """抠出 MB_EN 的键集合。键里的 \\\\ 等转义要按 JS 的字面量语义还原，
    否则跟 t() 里的写法比不出真假 —— 这正是这条测试要抓的那类错。"""
    head = src.index("const MB_EN = {")
    i = src.index("{", head)
    depth, j = 0, i
    while j < len(src):
        if src[j] == "{":
            depth += 1
        elif src[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = src[i:j + 1]
    keys = re.findall(r'^\s*"((?:\\.|[^"\\])*)"\s*:', body, re.M)
    return {_js_unescape(k) for k in keys}, src[:i] + src[j + 1:]


def _js_unescape(s):
    return (s.replace('\\"', '"').replace("\\'", "'")
             .replace("\\n", "\n").replace("\\\\", "\\"))


def test_every_t_key_has_english():
    """t() 用到的每个中文键都得在 MB_EN 里 —— 漏一个，切英文时那句就漏出中文。

    也挡转义写错：t("D:\\\\\\\\models") 跟字典键 "D:\\\\models" 是两个字符串，
    看起来一样、运行时对不上，中英文两边都会显示错的反斜杠。
    """
    src = _mediabrowser_js()
    en_keys, rest = _mb_en_dict(src)
    css = re.search(r"const css = `[\s\S]*?`;\r?\n", rest)
    if css:
        rest = rest[:css.start()] + rest[css.end():]
    used = set()
    for quote in ('"', "'"):
        pat = re.compile(r"\bt\(\s*" + quote
                         + r"((?:\\.|(?!" + quote + r")[^\r\n])*)" + quote)
        used.update(_js_unescape(m.group(1)) for m in pat.finditer(rest))
    for attr in re.finditer(r'data-i18n(?:-html|-placeholder|-title|-label)?="([^"]*)"', rest):
        used.add(attr.group(1))
    cjk = re.compile(r"[\u4e00-\u9fff]")
    missing = sorted(s for s in used if cjk.search(s) and s not in en_keys)
    if missing:
        raise AssertionError(f"这些中文没有英文对照，切英文会漏出来: {missing}")


def test_lock_lives_in_bottom_bar_not_over_the_picture():
    """锁在底栏，左上角只剩眼睛 —— 所以眼睛坐第一格，别给锁留空位。

    叠在左上角时点图容易误锁，才把锁挪进底栏。挪完 CSS 里若还留着
    .mb-lock 的座位，眼睛会往右缩一格、左边空一块，角标也跟着多让一格。
    """
    src = _mediabrowser_js()
    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    if not css_m:
        raise AssertionError("找不到 css 模板")
    css = css_m.group(1)
    if "mb-lock" in css:
        raise AssertionError("锁已挪进底栏，CSS 不该再有 .mb-lock 的座位")
    if 'className = "mb-lock"' in src:
        raise AssertionError("格子上不该再挂 .mb-lock 覆盖钮")
    if ".mb-cell .mb-peek{position:absolute;top:3px;left:3px;" not in css:
        raise AssertionError("眼睛应当坐左上第一格 left:3px")


def test_favorite_and_recent_are_persistent_responsive_scope_actions():
    """收藏/最近必须常驻可见；窗口变窄只收文字，不能靠绝对定位挤叠顶栏。"""
    src = _mediabrowser_js()
    first = src.find('<div class="mb-top-row">')
    end = src.find('</div>', first)
    row = src[first:end]
    for scope in ('@fav', '@recent'):
        if f'data-scope="{scope}"' not in row:
            raise AssertionError(f"第一行缺少常驻范围入口: {scope}")
    if 'class="mb-scope-icon"' not in row:
        raise AssertionError("范围按钮的图标要有独立容器，切激活态时不能覆盖文字标签")
    if "setIco(favButton," in src:
        raise AssertionError("setIco 会替换整个按钮内容，收藏激活后不能把‘收藏’文字抹掉")

    select_start = src.find('<select class="mb-root"', first)
    select_end = src.find('</select>', select_start)
    root_select = src[select_start:select_end]
    if 'value="@fav"' in root_select or 'value="@recent"' in root_select:
        raise AssertionError("收藏/最近不能继续只藏在原生目录下拉框里")

    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    if not css_m:
        raise AssertionError("找不到 css 模板")
    css = css_m.group(1)
    group_i = css.find(".mb-scope-special{")
    group = css[group_i:css.find("}", group_i)] if group_i >= 0 else ""
    if "display:flex" not in group or "position:absolute" in group:
        raise AssertionError("收藏入口组必须参与第一行 flex 流式布局，不能绝对定位")
    button_i = css.find(".mb-scope-special button{")
    button = css[button_i:css.find("}", button_i)] if button_i >= 0 else ""
    if "min-height:34px" not in button or "flex:0 0 auto" not in button:
        raise AssertionError("常驻入口要保留稳定点击区，缩小时不能被压扁")
    if "@container mb-picker (max-width:" not in css:
        raise AssertionError("窗口可拖拽缩放，收藏入口应按窗口容器而不是只按屏幕宽度响应")
    compact_i = css.find(".mb-scope-special .lab{display:none")
    if compact_i < 0:
        raise AssertionError("窄窗口应只隐藏收藏/最近文字，保留图标按钮")
    if "min-width:min(var(--mb-min-w,460px),98vw)" not in css.replace(" ", ""):
        raise AssertionError("小于首选最小宽度的屏幕仍要服从 viewport，不能横向溢出")
    if "Math.min(window.innerWidth * 0.98, Math.max(MIN_W, w))" not in src:
        raise AssertionError("拖拽缩放也必须让 viewport 上限优先于首选最小宽度")
    if ".mb-touch .mb-top select,.mb-touch .mb-top button{min-height:40px;min-width:42px;" not in css:
        raise AssertionError("混合输入设备进入触屏模式后，范围按钮也要使用触屏点击下限")


def test_viewer_unfavorite_refreshes_the_favorites_view():
    """大图里取消收藏后，背后的收藏列表也必须刷新，关掉查看器不能看到幽灵条目。"""
    src = _mediabrowser_js()
    start = src.index("const openViewerAt =")
    end = src.index("openViewer(files", start)
    hooks = src[start:end]
    assert "toggleFav: (pp)" in hooks, "查看器不能直接绕过收藏视图的刷新逻辑"
    assert "favMode() && !on" in hooks, "查看器取消收藏时没有刷新收藏视图"


def test_language_change_refreshes_scope_accessibility_labels():
    """运行中切语言时，收藏/最近的 aria-label 也要一起切换。"""
    src = _mediabrowser_js()
    i = src.index("applyLangLive = () =>")
    body = src[i:src.index("};", i)]
    assert "syncScopeButtons()" in body


def test_batch_toolbar_sits_on_ops_row():
    """全选和批量钉在第二行左边；第一行仍是搜索/范围，不被挤走。"""
    src = _mediabrowser_js()
    first = src.find('<div class="mb-top-row">')
    ops = src.find('class="mb-top-row mb-top-ops"')
    if first < 0 or ops < 0:
        raise AssertionError("找不到顶栏两行")
    head = src[first:src.find('<div class="mb-chrome">', first)]
    if 'class="mb-selectall"' in head:
        raise AssertionError("全选不应占第一行，会把搜索和范围挤掉")
    row = src[ops:src.find('class="mb-crumbrow"', ops)]
    for needle in ('class="mb-selectall"', 'data-batch="clear"',
                   'data-batch="fav"', 'data-batch="trash"', 'mb-batch-acts'):
        if needle not in row:
            raise AssertionError(f"第二行左边缺批量控件: {needle}")
    if row.find("mb-selectall") > row.find("mb-censor-g"):
        raise AssertionError("全选必须在遮蔽那一组左边")
    if "margin-right:auto" not in src[src.find(".mb-batch{"):src.find(".mb-top .mb-selectall")]:
        raise AssertionError("批量条要 margin-right:auto 才能钉在第二行左边")


def test_picker_toolbar_has_stable_responsive_groups():
    """控件只能整组换行；搜索框不能被挤成窄条，窄屏类型按钮收成图标。"""
    src = _mediabrowser_js()
    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    assert css_m, "找不到 css 模板"
    css = re.sub(r"\s+", "", css_m.group(1))
    assert ".mb-topinput[type=text]{box-sizing:border-box;flex:11260px;min-width:min(220px,100%);" in css
    assert ".mb-kinds{display:flex;gap:3px;flex:00auto;flex-wrap:nowrap;" in css
    assert ".mb-kinds.lab,.mb-kinds.count{display:none;" in css, "窄窗口应保留图标和 tooltip"
    assert ".mb-top-row>input[type=text]{flex-basis:100%;" in css, "空间不足时搜索框应整行换行"
    assert ".mb-top-head{flex-wrap:wrap;}.mb-chrome{order:-1;margin-left:auto;}.mb-top-head>.mb-top-row{flex-basis:100%;}" in css, \
        "超窄窗口应让窗口按钮单独占行，把完整宽度还给搜索和筛选"


def test_virtual_scope_keeps_pin_button_width_stable():
    """收藏/最近没有可钉目录时应禁用按钮，而不是移除后让面包屑横跳。"""
    src = _mediabrowser_js()
    start = src.index("syncPin = () =>")
    end = src.index("pinBtn.onclick", start)
    body = src[start:end]
    assert "pinBtn.disabled = !canPin" in body
    assert "pinBtn.style.display" not in body


def test_batch_trash_captures_root_and_ignores_stale_view_updates():
    """批量回收执行期间即使切换范围，所有请求仍属于确认时的根，也不能改写新列表。"""
    src = _mediabrowser_js()
    start = src.index('mask.querySelector("[data-batch=trash]").onclick')
    end = src.index("  const paint =", start)
    body = src[start:end]
    assert "const root = realRoot();" in body
    assert "const opSeq = loadSeq;" in body
    assert "postTrash(root, p)" in body
    assert "forgetPath(root, p)" in body
    assert "mask.isConnected && loadSeq === opSeq" in body, "切换范围或关闭后的异步回收结果不能继续改写当前列表"


def test_batch_favorite_uses_one_storage_update():
    """大批量收藏必须一次合并、一次持久化，不能按文件反复复制集合和写 JSON。"""
    src = _mediabrowser_js()
    start = src.index('mask.querySelector("[data-batch=fav]").onclick')
    end = src.index('mask.querySelector("[data-batch=trash]")', start)
    body = src[start:end]
    assert "setFavsIn(realRoot(), paths, want)" in body
    assert "for (const p of paths)" not in body
    assert "const favs = favSet(realRoot());" in body
    assert "(p) => favs.has(p)" in body

    sync_start = src.index("const syncSelection = () =>")
    sync_end = src.index('mask.querySelector(".mb-selectall").onclick', sync_start)
    sync_body = src[sync_start:sync_end]
    assert "const favs = favSet(realRoot());" in sync_body
    assert "(p) => favs.has(p)" in sync_body


def test_touch_mode_always_repairs_the_global_marker():
    """面板状态相同也不能提前返回，因为 html 上的全局触屏类可能被旧窗口留下。"""
    src = _mediabrowser_js()
    start = src.index("const setTouch = (on")
    end = src.index("  // 初值：", start)
    body = src[start:end]
    global_sync = body.index('document.documentElement.classList.toggle("mb-touch", on)')
    early_return = body.index("if (!changed) return")
    assert global_sync < early_return
    assert src.index("const syncSize = () =>") < src.index("setTouch(startTouch, false)"), \
        "触屏初始化会调用 syncSize，必须等它完成声明后再执行"


def test_card_checkbox_appears_on_hover_at_top_left():
    """格子勾选框平时不画；鼠标悬停出现在左上角第一格，眼睛/角标往右让。

    有选区后所有文件格都露出勾选框。点勾选开始多选；选区清空后恢复原点击。
    """
    src = _mediabrowser_js()
    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    if not css_m:
        raise AssertionError("找不到 css 模板")
    css = css_m.group(1)
    if ".mb-cell .mb-check{" not in css:
        raise AssertionError("缺少格子勾选框")
    check_start = css.find(".mb-cell .mb-check{")
    check = css[check_start:css.find(".mb-cell.checked{", check_start)]
    shared_i = css.find(".mb-cell .mb-check,.mb-cell .mb-peek,")
    shared = css[shared_i:css.find("}", shared_i)] if shared_i >= 0 else ""
    compact = (shared + check).replace(" ", "")
    if "opacity:0" not in check or "pointer-events:none" not in check:
        raise AssertionError("闲置时勾选框必须藏起来")
    if "width:var(--mb-peek,26px)" not in compact:
        raise AssertionError("勾选框必须跟眼睛同一套 --mb-peek，随格子缩放，不能写死像素")
    if "rgba(255,255,255,.92)" not in compact:
        raise AssertionError("卡片勾要保持原来的白底，不能改成跳过那种深色板")
    if "#3b82f6" not in css[css.find(".mb-cell .mb-check.on::before{"):css.find(".mb-cell.checked{")]:
        raise AssertionError("卡片勾选中态要保持原来的蓝，不能改成跳过.on")
    if "background:" in shared or "border:" in shared or "box-shadow:" in shared:
        raise AssertionError("卡片勾只能和眼睛/跳过共用几何尺寸，不能共用背景或边框样式")
    if "width:18px" in check:
        raise AssertionError("勾选框还在写死 18px，大格子会显得过小")
    if ":where(html:not(.mb-touch)) .mb-cell:hover .mb-check" not in css:
        raise AssertionError("鼠标悬停必须露出勾选框")
    if ".mb-box.touching .mb-cell:not(.dir) .mb-check{opacity:1;pointer-events:auto;}" not in css:
        raise AssertionError("触屏模式必须像其它卡片角标一样露出勾选框")
    idle_start = css.find(".mb-box.touching.bars-idle")
    idle_end = css.find("{opacity:0", idle_start)
    idle = css[idle_start:idle_end]
    if ".mb-cell:not(.checked) .mb-check" not in idle:
        raise AssertionError("未选中的触屏勾选框必须跟其它角标一起闲置淡出，避免长期挡图")
    if ".mb-box.mb-selecting .mb-cell:not(.dir) .mb-check{opacity:1;pointer-events:auto;}" not in css:
        raise AssertionError("有选区后文件格子要露出勾选框")
    peek_yield = css[css.find(".mb-box.mb-selecting .mb-cell .mb-peek{"):]
    peek_yield = peek_yield[:peek_yield.find("}")]
    if "var(--mb-peek,26px)" not in peek_yield:
        raise AssertionError("悬停出勾时眼睛让位必须跟勾的 --mb-peek 走，不能写死 18px")
    if "6px + 18px" in css or "width:18px;height:18px" in css:
        raise AssertionError("勾选框或其让位还残留写死的 18px")
    if "cellClickIntent({ isDir: false, hasSelection: selected.size > 0 })" not in src:
        raise AssertionError("有选区后点文件必须走加减选，不能仍是看大图/选中")
    if "nextSelectAll(selectablePaths(show), selected)" not in src:
        raise AssertionError("顶栏全选必须走 nextSelectAll")
    i = src.find(".mb-box.click-view .mb-cell:not(.dir){cursor:zoom-in;}")
    j = src.find(".mb-box.mb-selecting .mb-cell:not(.dir){cursor:pointer;}")
    if i < 0 or j < 0 or j < i:
        raise AssertionError("多选时光标必须写在看大图放大镜后面，否则会被盖掉")


def test_card_corner_controls_share_the_same_hit_box():
    """多选勾和眼睛/重检/跳过共用响应式点击区，视觉图形可在区内单独收小。"""
    src = _mediabrowser_js()
    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    if not css_m:
        raise AssertionError("找不到 css 模板")
    css = css_m.group(1).replace(" ", "").replace("\n", "")
    expected = (
        ".mb-cell.mb-check,.mb-cell.mb-peek,"
        ".mb-cell.mb-redo,.mb-cell.mb-skip{"
    )
    # CSS 源码里的后代选择器在去空格后正好变成 .mb-cell.mb-*。
    i = css.find(expected)
    if i < 0:
        raise AssertionError("四个角落控件没有共用同一条点击区尺寸规则，后续还会再次漂移")
    rule = css[i:css.find("}", i)]
    for needle in (
        "box-sizing:border-box",
        "width:var(--mb-peek,26px)",
        "height:var(--mb-peek,26px)",
        "padding:0",
        "border-radius:6px",
    ):
        if needle not in rule:
            raise AssertionError(f"角落控件共用点击区规则缺少 {needle}")


def test_card_checkbox_uses_responsive_kb_style_inner_chip():
    """点击区保持统一，内部白色芯片按图标占比缩小，并复用 kb-studio 的跨封面对比方案。"""
    src = _mediabrowser_js()
    css_m = re.search(r"const css = `([\s\S]*?)`;\r?\n", src)
    if not css_m:
        raise AssertionError("找不到 css 模板")
    css = css_m.group(1).replace(" ", "").replace("\n", "")

    i = css.find(".mb-cell.mb-check::before{")
    if i < 0:
        raise AssertionError("复选框仍把整个点击区画成白块，没有独立的内部芯片")
    chip = css[i:css.find("}", i)]
    for needle in (
        "width:70%",
        "height:70%",
        "background:rgba(255,255,255,.92)",
        "backdrop-filter:blur(10px)",
        "-webkit-backdrop-filter:blur(10px)",
        "border:1pxsolidrgba(255,255,255,.96)",
        "inset01px0rgba(255,255,255,.8)",
        "0001pxrgba(15,23,42,.2)",
        "01px3pxrgba(2,6,23,.38)",
    ):
        if needle not in chip:
            raise AssertionError(f"响应式高对比复选框芯片缺少 {needle}")

    check_i = css.find(".mb-cell.mb-check{")
    check = css[check_i:css.find("}", check_i)]
    for needle in ("background:transparent", "border:0", "box-shadow:none"):
        if needle not in check:
            raise AssertionError(f"复选框外层点击区不应再画白块，缺少 {needle}")

    icon_i = css.find(".mb-cell.mb-check.mb-ico{")
    icon = css[icon_i:css.find("}", icon_i)] if icon_i >= 0 else ""
    if "width:46%" not in icon or "height:46%" not in icon:
        raise AssertionError("选中勾号没有随内部芯片按统一比例缩放")


def test_picker_resize_recomputes_responsive_control_size():
    """拖动浏览窗以后要先刷新 --mb-peek，再按新格子宽度重排。"""
    src = _mediabrowser_js()
    i = src.find("const ro = new ResizeObserver")
    if i < 0:
        raise AssertionError("找不到浏览窗 ResizeObserver")
    body = src[i:i + 1100]
    resize = body[body.find("setTimeout"):]
    if "syncSize();" not in resize:
        raise AssertionError("窗口尺寸变化后没有重算响应式角落控件尺寸")
    if resize.find("syncSize();") > resize.find("reflow();"):
        raise AssertionError("必须先按新宽度重算控件尺寸，再重排格子")


def test_js_annotate_matches_backend_rule():
    """前端 annotate 必须跟后端 annotate_widget_value 同语义。

    后端这个函数没人调，只作规范锚点 —— 真正跑的是前端那份。
    只测 Python 那份等于测了个影子：写反了照样全绿，而入队会报
    Invalid image file，错误信息完全不提缺后缀。
    """
    src = _mediabrowser_js()
    i = src.find("const annotate =")
    if i < 0:
        raise AssertionError("找不到前端 annotate")
    line = src[i:src.find("\n", i)]
    if 'root === "input" ? path' not in line or "[${root}]" not in line:
        raise AssertionError(f"前端 annotate 规则跟后端对不上: {line}")
    for kind in ("output", "temp"):
        assert mb.annotate_widget_value("a.png", kind) == f"a.png [{kind}]"


def test_entry_button_and_manager_keywords():
    """入口按钮叫「浏览资源」；去重判据仍用前缀，改名不能把它打断。

    另核 pyproject 的 DisplayName —— ComfyUI-Manager 搜的是
    title/author/description（且要求关键词落在**同一字段**里按顺序出现），
    节点上的按钮名字不在它的索引里，只改按钮搜不到。
    """
    src = _mediabrowser_js()
    if '"🔲 浏览资源"' not in src:
        raise AssertionError("入口按钮应当叫 🔲 浏览资源")
    if 'startsWith("🔲 浏览")' not in src:
        raise AssertionError("去重判据必须留成前缀匹配，否则改名会重复加按钮")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    toml = open(os.path.join(root, "pyproject.toml"), encoding="utf-8").read()
    m = re.search(r'DisplayName\s*=\s*"([^"]*)"', toml)
    if not m or "浏览资源" not in m.group(1):
        raise AssertionError(f"DisplayName 里要有「浏览资源」，现在是 {m and m.group(1)!r}")


def test_readme_describes_features_not_emoji():
    """README 用功能名描述界面，不画 emoji。

    界面早就换成 lucide 线描图标了，README 还写 🔍/ⓘ/⧉ 的话，
    新用户照着找不到对应的东西。写功能名还能免掉「图标一变文档就得跟着改」。
    入口按钮的 🔲 是例外：那是产品定的视觉锚点，界面上真的有。
    """
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    readme = open(os.path.join(root, "README.md"), encoding="utf-8").read()
    stale = [e for e in ("🔍", "ⓘ", "⧉", "🚫", "⟳", "⚙", "★", "🕒", "📌") if e in readme]
    if stale:
        raise AssertionError(f"README 仍在用 emoji 指代界面元素: {stale}")


def test_regions_cache_has_capacity_cap():
    """检测结果缓存必须有容量上限并能自动修剪。

    它只增不减：每检测一张图多一条，删掉原图也不会带走它。
    缩略图缓存有 _THUMB_MAX_FILES，这里原来没有，只能在设置里手动清。
    """
    import censor
    for name in ("_REGIONS_MAX_FILES", "_REGIONS_TRIM_EVERY", "_trim_regions_cache"):
        if not hasattr(censor, name):
            raise AssertionError(f"censor 缺少 {name}")
    if censor._REGIONS_MAX_FILES < 1000:
        raise AssertionError("上限太小，正常使用就会反复淘汰")
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "censor.py"), encoding="utf-8").read()
    i = src.find("def write_cached")
    if "_trim_regions_cache()" not in src[i:i + 800]:
        raise AssertionError("write_cached 必须触发修剪，否则上限形同虚设")
    # 真跑一次：import time 之类的漏项只在运行时炸，语法检查抓不到
    censor._trim_regions_cache()


def test_infer_captures_its_own_abort_controller():
    """每轮检测必须捕获自己的 AbortController，不能在循环里读全局。

    读全局的话：再点一次「局部」→ 全局被换成新控制器 → **旧循环判断的是新控制器**，
    永远不为 aborted，于是两个检测循环并行跑，进度条在两个计数之间跳，
    inferBusy 被先跑完的那个置 false。
    """
    src = _mediabrowser_js()
    i = src.find("const startInfer")
    body = src[i:src.index("const syncCensorSeg", i)]
    if "const ac = new AbortController()" not in body:
        raise AssertionError("startInfer 必须把控制器捕获成局部变量")
    if "if (inferAbort.signal.aborted)" in body:
        raise AssertionError("循环里不能判断全局 inferAbort —— 它会被下一轮换掉")
    if "ac.signal.aborted" not in body:
        raise AssertionError("循环必须判断自己那个控制器")


def test_detect_concur_defaults_to_two_and_is_a_pref():
    """同时检测几张是设置项，默认 2，夹在 1～4。

    1 = 一次一张（弱机）；2 = 下一张解码叠这一张推理。再高收益很小，
    因为 ONNX session.run 仍然串行。必须登记进 PREF_KEYS，否则
    「恢复默认界面」清不掉，弱机改过 4 之后回不去。
    """
    src = _mediabrowser_js()
    assert 'CENSOR_CONCUR_KEY = "mediabrowser.censorConcur"' in src
    assert "CENSOR_CONCUR_DEFAULT = 2" in src
    i = src.find("const PREF_KEYS")
    block = src[i:i + 500]
    assert "CENSOR_CONCUR_KEY" in block, "没登记进 PREF_KEYS，恢复默认清不掉"
    body = src[src.find("const censorConcur"):src.find("const censorConcur") + 450]
    assert "CENSOR_CONCUR_MIN" in body and "CENSOR_CONCUR_MAX" in body
    assert "censorconcur" in src, "设置面板没有同时检测几张的下拉"
    assert 't("同时检测几张")' in src, "设置面板标题要用「同时检测几张」"


def test_fetch_one_takes_explicit_signal():
    """fetchOne 不能自己去读全局 inferAbort —— 那等于用别人的取消信号。

    预取（hydrateCacheOnly）必须走面板级 panelAbort：关面板要能真的断掉在飞的请求，
    而不是蹭每轮都会被换掉的检测控制器。
    """
    src = _mediabrowser_js()
    i = src.find("const fetchOne = async")
    body = src[i:i + 700]
    if "inferAbort" in body:
        raise AssertionError("fetchOne 里不该出现 inferAbort，signal 要由调用方传")
    if "signal = null" not in body:
        raise AssertionError("fetchOne 应当接受显式 signal 参数")
    if "const panelAbort" not in src:
        raise AssertionError("缺少面板生命周期的 panelAbort")
    j = src.find("const hydrateCacheOnly")
    if "panelAbort.signal" not in src[j:j + 600]:
        raise AssertionError("预取必须用 panelAbort.signal，关面板才断得掉")


def test_local_detect_uses_viewport_order_not_pool_order():
    """局部检测只打**真正看得见**的，且按看到的顺序。

    两个都错过：
    ① pool 含视口上下各 BUF 个格子的预加载缓冲，那些图用户没看见却会被真跑一遍
       检测（GPU 活），而文案写的是「只打眼前这一屏」——说到没做到。
    ② pool 是 Map，遍历按插入顺序；paint 滚动时删旧追新，几轮后顺序和视觉位置
       完全对不上，表现为「点了局部却不是从我看到的第一张开始打」。
    """
    src = _mediabrowser_js()
    if "const mediaInView" not in src:
        raise AssertionError("缺少按视口+顺序取图的 mediaInView")
    i = src.find("const mediaInView")
    body = src[i:i + 900]
    if "scroll.scrollTop" not in body or "clientHeight" not in body:
        raise AssertionError("mediaInView 必须按真实视口范围过滤，不能直接用整个 pool")
    if ".sort(" not in body:
        raise AssertionError("mediaInView 必须排序（从上到下、同排从左到右）")
    # 检测入口必须用它；画缓存/预取则**应当**继续用 visibleMedia（要覆盖缓冲区）
    j = src.find("const unhitVisible")
    if "mediaInView()" not in src[j:j + 120]:
        raise AssertionError("unhitVisible 必须走 mediaInView")
    for name in ("applyLocalCaches", "hydrateCacheOnly"):
        k = src.find("const " + name)
        seg = src[k:k + 400]
        if "visibleMedia()" not in seg:
            raise AssertionError(f"{name} 应当继续用 visibleMedia（覆盖预加载缓冲，"
                                 f"滚进来时才不会白一下）")


def test_scroll_is_raf_throttled_not_debounced():
    """滚动必须是 rAF 节流，不能是 setTimeout 防抖。

    防抖的意思是「连续滚动期间一次都不重绘」——手不停就一直空着，
    停下来才唰地长出来。节流才是滑到哪补到哪。
    """
    src = _mediabrowser_js()
    i = src.find('scroll.addEventListener("scroll"')
    if i < 0:
        raise AssertionError("找不到滚动监听")
    handler = src[i:i + 300]
    if "setTimeout" in handler:
        raise AssertionError(f"滚动还在用 setTimeout 防抖: {handler[:140]}")
    if "requestAnimationFrame" not in handler:
        raise AssertionError("滚动应当用 requestAnimationFrame 节流")


def test_paint_batches_dom_inserts():
    """一屏 30 个格子要一次性插进去，不要逐个 appendChild 让浏览器反复重排。"""
    src = _mediabrowser_js()
    if "createDocumentFragment" not in src:
        raise AssertionError("paint 应当先攒进 DocumentFragment 再一次插入")


def test_censor_gate_is_single_source():
    """能不能遮由一条判据说了算，宫格底栏和查看器底栏共用。

    原来这条判断在两处各写了一遍 KIND_VID||KIND_IMG，改一处会漏另一处 ——
    「查看器锁得上、回宫格找不到钮解锁」就是这么来的。
    """
    src = _mediabrowser_js()
    if "const canCensor = " not in src:
        raise AssertionError("缺少统一判据 canCensor")
    combos = re.findall(
        r"KIND_VID\.test\([^)]*\)\s*\|\|\s*KIND_IMG\.test\([^)]*\)"
        r"|KIND_IMG\.test\([^)]*\)\s*\|\|\s*KIND_VID\.test\([^)]*\)", src)
    if len(combos) > 1:
        raise AssertionError(f"能不能遮的判断散写了 {len(combos)} 处，应当只在 canCensor 里")


def test_icons_are_self_hosted():
    """图标 CSS 必须自带，不能靠 ComfyUI 打包出来的 class。

    icon-[lucide--x] 这些 class 来自 ComfyUI 的 UnoCSS 产物 —— 那是它的内部实现，
    不是对插件的承诺。它换一次图标集我们就是满屏空方块，而且不报错。
    """
    web = _web_dir()
    css_path = os.path.join(web, "mb-icons.css")
    if not os.path.isfile(css_path):
        raise AssertionError("缺 web/mb-icons.css")
    css = open(css_path, encoding="utf-8").read()
    src = _mediabrowser_js()
    if "mb-icons.css" not in src:
        raise AssertionError("mediabrowser.js 没有加载 mb-icons.css")
    if "import.meta.url" not in src:
        raise AssertionError("图标 CSS 的地址应当由 import.meta.url 推出来，"
                             "别硬编码 /extensions/<目录名>：那个名字由 ComfyUI 决定，猜错就 404")
    # 图标名是当**字符串**传给 mbIco/setIco 的，源码里没有字面量 icon-[...]。
    # 拿 icon-\[ 去扫源码会一条都找不到 —— 那样这条测试就成了永远通过的摆设。
    used = set(re.findall(r'(?:mbIco|setIco)\([^)]*?"([a-z0-9]+--[a-z0-9-]+)"', src))
    if len(used) < 20:
        raise AssertionError(f"只扫到 {len(used)} 个图标引用，提取规则多半失效了")
    have = set(re.findall(r"icon-\\\[([a-z0-9]+--[a-z0-9-]+)\\\]", css))
    missing = sorted(used - have)
    if missing:
        raise AssertionError(f"这些图标没自带，脱开 ComfyUI 会是空方块: {missing}")
    duplicate_mask = "-webkit-mask-image:var(--svg);-webkit-mask-image:var(--svg);"
    if duplicate_mask in css:
        raise AssertionError("图标生成结果重复声明相同 mask；应在生成器中归一化，避免每条规则膨胀")


def test_send_to_recycle_refuses_missing_and_dir():
    root = mb._DIRS["output"]()
    os.makedirs(root, exist_ok=True)
    try:
        mb._send_to_recycle(os.path.join(root, "nope-recycle.txt"))
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("缺文件应当 FileNotFoundError")
    d = os.path.join(root, "_mb_dir")
    os.makedirs(d, exist_ok=True)
    try:
        mb._send_to_recycle(d)
    except ValueError:
        return
    raise AssertionError("目录应当被拒")


def test_elapsed_never_touches_the_file():
    """记耗时**绝不能改用户的文件**。

    这是换实现的全部理由。早期版本把秒数写进 PNG 的 tEXt 块，代价是：
      · 重写就有丢数据的可能（实测丢过 IEND 之后 2713 字节的编辑器参数）
      · mtime 和 size 都变 → 缩略图缓存键和检测缓存键**都含这两项** →
        每记一张就作废它的封面和已检测的框
      · 内容变了 → 任何按内容哈希去重/同步的系统都当它是新文件
    所以这条直接盯「字节、mtime、size 一个都不许动」。
    """
    import tempfile
    from PIL import Image
    td = tempfile.mkdtemp(prefix="mb-elapsed-untouched-")
    try:
        p = os.path.join(td, "a.png")
        Image.new("RGB", (8, 6), (1, 2, 3)).save(p)
        before = open(p, "rb").read()
        st0 = os.stat(p)

        assert mb.remember_elapsed(st0, 12.5) is True
        assert mb.recall_elapsed(st0) == 12.5

        st1 = os.stat(p)
        assert open(p, "rb").read() == before, "文件内容被改了"
        assert st1.st_mtime_ns == st0.st_mtime_ns, "mtime 变了 → 缩略图和检测缓存会作废"
        assert st1.st_size == st0.st_size, "size 变了 → 同上"
        assert not [f for f in os.listdir(td) if f != "a.png"], \
            f"在用户目录里留了别的文件: {os.listdir(td)}"
    finally:
        import shutil
        shutil.rmtree(td, ignore_errors=True)


def test_elapsed_key_survives_rename_and_move():
    """索引键必须扛得住改名和挪目录 —— 这是当初选「写进文件」的唯一理由。

    实测 rename / 同卷 move / 跨卷 move（走 copy2）都不改 mtime 和 size，
    所以按 size+mtime 索引同样认得出来，不必去动文件。
    """
    import shutil
    import tempfile
    a = tempfile.mkdtemp(prefix="mb-key-a-")
    b = tempfile.mkdtemp(prefix="mb-key-b-")
    try:
        p = os.path.join(a, "x.png")
        with open(p, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"0" * 500)
        st0 = os.stat(p)
        mb.remember_elapsed(st0, 33.0)

        q = os.path.join(a, "renamed.png")
        os.rename(p, q)
        assert mb.recall_elapsed(os.stat(q)) == 33.0, "改名之后查不到了"

        r = os.path.join(b, "renamed.png")
        shutil.move(q, r)
        assert mb.recall_elapsed(os.stat(r)) == 33.0, "挪目录之后查不到了"
    finally:
        import shutil as sh
        sh.rmtree(a, ignore_errors=True)
        sh.rmtree(b, ignore_errors=True)


def test_fill_dims_reads_index_on_every_path():
    """_fill_dims 有**三条**出口，每条都得查旁挂索引。

    三条是：① 尺寸缓存命中就 continue ② 预算外 ③ 预算内现算。
    只接其中一两条的后果很隐蔽：改名后第一次刷新还能看到耗时（走 ②/③），
    第二次就没了（① 命中后直接 continue）—— 比「一直没有」更难查。
    上面那条 survives_rename 只直接调 recall_elapsed，走不到这里，抓不到这个。
    """
    import shutil
    import tempfile
    from PIL import Image
    td = tempfile.mkdtemp(prefix="mb-three-paths-")
    rel = "renamed.png"
    prev_dims = mb._DIMS.pop(rel, None)
    old_budget = mb.DIM_BUDGET
    try:
        p = os.path.join(td, rel)
        Image.new("RGB", (16, 12), (5, 6, 7)).save(p)
        st = os.stat(p)
        mb.remember_elapsed(st, 55.5)
        rec = {"p": rel, "a": p, "t": st.st_mtime}

        # ③ 预算内现算
        got = mb._fill_dims([rec])["elapsed"].get(rel)
        assert got == 55.5, f"预算内那条没查索引: {got}"

        # ① 尺寸缓存命中（_fill_dims 刚写进 _DIMS，且 elapsed 位是 0）
        assert rel in mb._DIMS, "上一步应当已经把尺寸写进 _DIMS"
        got = mb._fill_dims([rec])["elapsed"].get(rel)
        assert got == 55.5, f"缓存命中那条没查索引: {got} —— 这条最常走"

        # ② 预算外
        mb.DIM_BUDGET = 0
        mb._DIMS.pop(rel, None)
        got = mb._fill_dims([rec])["elapsed"].get(rel)
        assert got == 55.5, f"预算外那条没查索引: {got}"
    finally:
        mb.DIM_BUDGET = old_budget
        if prev_dims is None:
            mb._DIMS.pop(rel, None)
        else:
            mb._DIMS[rel] = prev_dims
        shutil.rmtree(td, ignore_errors=True)


def test_elapsed_index_is_capped_and_registered():
    """索引只增不减，必须有上限；而且它是插件缓存，要能被「清缓存」带走。"""
    assert mb._ELAPSED_MAX >= 1000
    assert mb.ELAPSED_INDEX.startswith(mb.CACHE_DIR), \
        "索引必须落在插件的缓存目录里，不能散在别处"
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "__init__.py"), encoding="utf-8").read()
    i = src.find("def _save_elapsed")
    if "_ELAPSED_MAX" not in src[i:i + 900]:
        raise AssertionError("_save_elapsed 必须在落盘时执行上限，否则上限形同虚设")


def test_old_png_elapsed_is_still_readable():
    """老图身上还带着早期版本写进 PNG 的 elapsed 块，读这条路必须留着。

    写那条路已经拆了，但用户手上已经有一批被写过的图 ——
    把读也删掉的话，那些图的耗时会凭空消失。
    """
    assert hasattr(mb, "elapsed_from_png_info")
    assert mb.elapsed_from_png_info({"elapsed": "8.5"}) == 8.5
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "__init__.py"), encoding="utf-8").read()
    if "def embed_elapsed_png" in src:
        raise AssertionError("写 PNG 那条路应当已经拆掉")
    i = src.find("def _fill_dims")
    if "elapsed_from_png_info" not in src[i:i + 2600]:
        raise AssertionError("_fill_dims 里要保留对老图的回落读取")


def test_fill_dims_over_budget_does_not_freeze_mtime():
    """预算外只补耗时，不得把新 mtime 写进索引把尺寸冻死。"""
    import tempfile
    from PIL import Image
    td = tempfile.mkdtemp(prefix="mb-fill-mtime-")
    old_budget = mb.DIM_BUDGET
    rel = "over-budget.png"
    prev = mb._DIMS.pop(rel, None)
    mb.DIM_BUDGET = 0
    try:
        src = os.path.join(td, rel)
        Image.new("RGB", (8, 6), (2, 3, 4)).save(src)
        # 耗时进旁挂索引，不写文件 —— 索引键是 size+mtime，所以要先 stat
        assert mb.remember_elapsed(os.stat(src), 7.25) is True
        mb._DIMS[rel] = [8, 6, 1.0, 0, 0, 0]
        pack = mb._fill_dims([{"p": rel, "a": src, "t": 999.0}])
        rec = mb._DIMS[rel]
        assert rec[2] == 1.0
        assert rec[0] == 8 and rec[1] == 6
        assert pack["elapsed"].get(rel) == 7.25
    finally:
        mb.DIM_BUDGET = old_budget
        if prev is None:
            mb._DIMS.pop(rel, None)
        else:
            mb._DIMS[rel] = prev
        import shutil
        shutil.rmtree(td, ignore_errors=True)


def test_place_key_cleared_with_prefs():
    """完全重置 / 恢复默认界面必须清掉上次位置，否则重载又跳回旧目录。"""
    src = _mediabrowser_js()
    i = src.find("const PREF_KEYS")
    block = src[i:i + 400]
    if "PLACE_KEY" not in block:
        raise AssertionError("PREF_KEYS 必须包含 PLACE_KEY")


def test_load_retries_missing_remembered_dir():
    """记住的子目录没了，必须清掉再扫根，不能停在红字。"""
    src = _mediabrowser_js()
    i = src.find("const load = async")
    body = src[i:i + 2200]
    if "isMissingDirError" not in body:
        raise AssertionError("load 必须用 isMissingDirError 判断缺目录")
    if "savePlace" not in body:
        raise AssertionError("回退后必须立刻忘掉那个不存在的路径")
    if 'cwd = ""' not in body:
        raise AssertionError("缺目录时必须把 cwd 清掉再扫根")


def _js_ladder():
    """JS 那边唯一的档位阶梯。"""
    src = _mediabrowser_js()
    m = re.search(r"const THUMB_PX_LADDER = \[([^\]]*)\]", src)
    if not m:
        raise AssertionError("找不到 THUMB_PX_LADDER")
    return [int(x) for x in re.findall(r"\d+", m.group(1))]


def _js_presets():
    """从 JS 里解析 THUMB_PRESETS；THUMB_NATIVE_PX 记为 0（原像素）。"""
    src = _mediabrowser_js()
    m = re.search(r"const THUMB_PRESETS = \{(.*?)\n\};", src, re.S)
    if not m:
        raise AssertionError("找不到 THUMB_PRESETS")
    out = {}
    for name, tbl in re.findall(r"(\w+):\s*\{([^}]*)\}", m.group(1)):
        out[name] = {int(a): (0 if b == "THUMB_NATIVE_PX" else int(b))
                     for a, b in re.findall(r"(\d+)\s*:\s*(\d+|THUMB_NATIVE_PX)", tbl)}
    return out


def test_thumb_ladder_is_the_same_on_both_sides():
    """前端的档位阶梯和后端的 THUMB_SIZES 必须逐个相同。

    对不上是**静默**出错：后端 clamp_thumb_px 把请求吸附到最近一档，
    前端请求 640 而后端只有 512/768 时两边都差 128 → 落到 512。
    于是「清晰」和「均衡」在一行 6 个时拿到同一张图，设置里显示的
    和实际收到的不是一回事，而且不报任何错 —— 只能靠这条测试拦。
    """
    js = _js_ladder()
    py = [s for s in mb.THUMB_SIZES if s != mb.THUMB_NATIVE]
    assert js == sorted(js), f"阶梯要从小到大: {js}"
    assert js == sorted(py), f"两边对不上 —— JS {js} / Python {sorted(py)}"


def test_every_preset_px_is_a_real_tier():
    """预设里写的每个数都必须是阶梯上真有的一档。

    不在阶梯上的值会被后端吸附到别的档，用户选了「清晰」却拿到「均衡」的图。
    """
    ladder = set(_js_ladder()) | {0}          # 0 = 原像素
    for name, tbl in _js_presets().items():
        for cols, px in tbl.items():
            assert px in ladder, f"预设 {name} 的一行 {cols} 个配了 {px}，不是阶梯上的档"


def test_release_url_is_not_silently_forked():
    """权重发布页这个 URL 在三处各存了一份，必须钉住它们一致。

    censor.py 没加载成功时 __init__ 拿不到 censor.RELEASE_URL，所以那份
    必须独立存在；前端也留了一份兜底。三份里改漏一处不会报错，
    只会有人点到过期链接。
    """
    import importlib.util as ilu
    spec = ilu.spec_from_file_location(
        "mb_censor_for_test", os.path.join(os.path.dirname(_web_dir()), "censor.py"))
    cen = ilu.module_from_spec(spec)
    spec.loader.exec_module(cen)
    assert mb._FALLBACK_RELEASE_URL == cen.RELEASE_URL, (
        f"__init__ 的兜底 URL 与 censor.RELEASE_URL 不一致："
        f"{mb._FALLBACK_RELEASE_URL} vs {cen.RELEASE_URL}")
    assert cen.RELEASE_URL in _mediabrowser_js(), (
        f"前端兜底的发布页 URL 与后端不一致，后端是 {cen.RELEASE_URL}")


def test_bundled_icon_sets_are_all_attributed():
    """自带的每个图标集都必须在 NOTICE 里写明出处和许可证。

    图标是随源码一起分发的第三方素材：Lucide 是 ISC、Phosphor 是 MIT，
    两者都要求「保留版权声明和许可声明」。而且 ComfyUI 前端打包里混着
    它自己画的 comfy--* 那一套（跟本项目不是同一个许可证）——
    照抄规则时很容易顺手带进来，带进来了也不会有任何提示。
    这条测试就是那道闸：新出现一个没写进 NOTICE 的图标集，直接失败。
    """
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    css = open(os.path.join(root, "web", "mb-icons.css"), encoding="utf-8").read()
    notice_path = os.path.join(root, "NOTICE")
    assert os.path.isfile(notice_path), "缺 NOTICE —— 自带第三方图标就必须有归属声明"
    notice = open(notice_path, encoding="utf-8").read()
    # CSS 里是 icon-\[lucide--…：正则里反斜杠和方括号都要再转一次
    pat = "icon-" + chr(92) * 3 + "[([a-z0-9]+)--"
    sets = sorted(set(re.findall(pat, css)))
    assert sets, "mb-icons.css 里一个图标规则都没解析出来"
    # 每个图标集要查两样：**带空格的正式名**和**许可证名**。
    # 不能只查小写的集合名 —— "phosphor" 在 phosphoricons.com 这个网址里也有，
    # 把归属整段删掉它照样命中，等于没查。
    known = {
        "lucide": ("Lucide", "ISC License"),
        "ph": ("Phosphor Icons", "MIT License"),
    }
    for name in sets:
        assert name in known, (
            f"自带了没见过的图标集 {name}-- —— 先确认它的许可证跟 Apache-2.0 兼容，"
            f"再写进 NOTICE，最后把它加进这条测试的 known 表")
        who, lic = known[name]
        assert who in notice, f"NOTICE 里没写 {name}--（{who}）的归属"
        assert lic in notice, f"NOTICE 里有 {who} 但没附 {lic} 全文"


def test_popovers_can_actually_be_dismissed():
    """浮层必须有三条关掉的路：×、点外面、Esc。

    浮层是挂在 document.body 上的（要能摆到浏览窗口外面去），所以原来那条
    「点格子区就关」根本盖不住：菜单摆到窗口以外时点哪儿都关不掉，
    而右键菜单当时连 × 都没有 —— 开出来就赖在屏幕上。
    """
    src = _mediabrowser_js()
    # 标题栏和「点外面 / Esc 关掉」都在共用外壳 makePopShell 里 ——
    # 「⋯」菜单和遮蔽面板都从它来，查这一处就等于两边都查了
    i = src.find("const makePopShell")
    if i < 0:
        raise AssertionError("缺 makePopShell —— 浮层外壳应当只有一份")
    body = src[i:i + 3000]
    if 'class="x"' not in body:
        raise AssertionError("浮层缺 × 关闭按钮")
    if "armPopDismiss(pop)" not in body:
        raise AssertionError("浮层没接上「点外面 / Esc 关掉」")
    # 两个界面都必须用这个外壳，不能各搭各的
    for who in ("const openCellMenu", "const openCensorPanel"):
        j = src.find(who)
        assert j > 0, f"找不到 {who}"
        if "makePopShell(" not in src[j:j + 900]:
            raise AssertionError(f"{who} 没用共用外壳，标题栏/关闭方式会两边不一致")
    j = src.find("const armPopDismiss")
    if j < 0:
        raise AssertionError("缺 armPopDismiss")
    arm = src[j:j + 900]
    # 两条都必须是 **capture**：格子和浮层自己都会 stopPropagation，
    # 挂在冒泡阶段的话根本收不到，浮层就关不掉了 —— 只写 "true)" 查不出来，
    # 因为同一段里 removeEventListener 也带 true（变异测试实测漏过）。
    for need, why in (
        ('addEventListener("pointerdown", onDown, true)',
         "点外面要靠 document 上的 pointerdown，且必须是 capture"),
        ('addEventListener("keydown", onKey, true)',
         "Esc 要能关，且必须是 capture"),
        ("el.contains", "只在点到浮层外面时才关"),
        ("stopPropagation", "Esc 只关浮层，不能顺手把整个浏览窗口也关了"),
    ):
        if need not in arm:
            raise AssertionError(f"armPopDismiss 缺 {need}：{why}")
    # 监听必须拆得掉，否则每开一次浮层就多挂一对，越点越慢
    if "popOff.push" not in arm or "removeEventListener" not in arm:
        raise AssertionError("装了监听却没登记怎么拆")


def test_presets_fill_the_table_rather_than_replace_it():
    """预设是「一键把逐档表填成那套数」，不是「另一种模式」。

    做成模式的话，选了预设就看不见每一档到底给多大，想知道只能切来切去试；
    而用户要的是**表一直在**、预设只是快速填表，填完还能逐档改。
    """
    src = _mediabrowser_js()
    for gone in ("thumbPxChoice", "THUMB_PX_CHOICES", '"per-cell"'):
        if gone in src:
            raise AssertionError(f"{gone} 还在 —— 预设不该再是一种「模式」")
    # 逐档表不能被藏在某个模式后面
    m = re.search(r'`<div class="mb-percell"([^`]*)`', src)
    if not m:
        raise AssertionError("找不到逐档表的容器")
    if "hidden" in m.group(1):
        raise AssertionError("逐档表被藏起来了 —— 它必须一直看得见")
    i = src.find("      thumbSel.onchange = ")
    assert i > 0, "找不到「一键套用」的处理函数"
    body = src[i:i + 1400]
    if "THUMB_PER_CELL_KEY" not in body:
        raise AssertionError("选预设必须写进逐档表（THUMB_PER_CELL_KEY）")
    if ".mb-percell select" not in body:
        raise AssertionError("选完预设要把表里的下拉同步成新值，否则表显示的还是旧数")
    if "syncPresetSel" not in src:
        raise AssertionError("表被逐档改过之后，「一键套用」那个下拉要回显成自定义")


def test_bar_or_menu_is_decided_by_measuring_the_cell():
    """摆在图上还是收进「⋯」，按**这一格放不放得下**判，不按「是不是手机」判。

    设备型号说明不了问题：同一台电脑把窗口拖窄、或者切到「一行 6 个」，
    格子照样放不下；而平板横过来放得下。量格子才量到了真正相关的那个量，
    窗口一拖、档位一换就自动跟着变，不用给每种设备写规则。
    触屏会更早收起来，是因为触屏按钮下限更大（--mb-btn-w/h），
    这条差异自然落在同一个判据里。
    """
    src = _mediabrowser_js()
    if "bar-fits" not in src:
        raise AssertionError("缺「这一格放不放得下」的判据")
    if 'box.classList.toggle("bar-fits"' not in src:
        raise AssertionError("bar-fits 必须由实测的格子宽算出来")
    i = src.find("const need = CELL_ACTION_IDS.length")
    if i < 0 or "bw" not in src[i:i + 160]:
        raise AssertionError("门槛要用**实际的按钮宽**算，不能写死一个数")
    if ".mb-box:not(.bar-fits) .mb-cell .mb-more{display:flex;}" not in src:
        raise AssertionError("放不下时才出「⋯」")
    # 不能再拿 touching 当显隐判据
    for bad in (".mb-box.touching .mb-cell .mb-more{display:flex;}",
                ".mb-box.touching .mb-cell .mb-bar,"):
        if bad in src:
            raise AssertionError(f"还在按「是不是触屏」决定显隐：{bad}")
    # 触屏没有右键，长按仍然要能开菜单
    j = src.find("c.oncontextmenu")
    body = src[j:j + 1400]
    if "openCellMenu" not in body or 'pointerType !== "touch"' not in body:
        raise AssertionError("触屏缺长按开菜单 —— 手指用户够不到进阶操作")


def test_actions_come_from_one_ordered_source():
    """一项资源身上的动作，**顺序只有一个真相源**（ACTION_ORDER）。

    哪个界面用得上哪几个可以不同 —— 用不上的直接不给，地方本来就紧，
    留个点不动的按钮是白占。但**相对顺序**必须处处一致：少了谁，剩下的次序不变。
    以前不是这样：同一个「删除」在格子里是最后一个、在大图里排在中间第 6 个，
    「收藏」从第 4 跑到第 7，连名字都不一样（格子「用这张」/ 大图「选这个」）——
    同一个动作三种位置，手感直接作废。
    """
    src = _mediabrowser_js()
    m = re.search(r"const ACTION_ORDER = \[(.*?)\];", src, re.S)
    if not m:
        raise AssertionError("缺 ACTION_ORDER —— 顺序得有个唯一真相源")
    order = re.findall(r'"(\w+)"', m.group(1))
    assert order[0] == "pick", f"主动作应当永远第一，现在是 {order[0]}"
    assert order[-1] == "trash", f"破坏性动作应当永远最后，现在是 {order[-1]}"

    # ① 格子那一组：必须按 ACTION_ORDER 排，不是按 push 的先后
    i = src.find("const cellActionsFor")
    body = src[i:src.index("return A;", i)]
    if "A.sort((a, b) => ACTION_ORDER.indexOf(a.id) - ACTION_ORDER.indexOf(b.id));" not in body:
        raise AssertionError("格子那一组没有按 ACTION_ORDER 排 —— push 的先后会决定位置")
    ids = re.findall(r'id: "(\w+)"', body)
    for x in ids:
        assert x in order, f"动作 {x} 不在 ACTION_ORDER 里，位置会乱"

    # ② 大图底栏：DOM 顺序必须是 ACTION_ORDER 的子序列
    j = src.find('<button type="button" class="pick">')
    bar = src[j:src.index('<button type="button" class="cls">', j)]
    seen = re.findall(r'class="(?:act )?([a-z-]+)"', bar)
    seen = [("shot" if x == "shot-one" else x) for x in seen]
    # 「打开遮蔽面板」是**导航**（点进去还有一层），不是对这一项做的动作，
    # 所以不排进 ACTION_ORDER —— 格子那边它也是单独的整行入口，摆在宫格最后。
    NAV = {"tune", "more"}
    seen = [x for x in seen if x not in NAV]
    pos = [order.index(x) for x in seen if x in order]
    assert pos == sorted(pos), f"大图底栏的顺序跟 ACTION_ORDER 对不上：{seen}"
    assert len(pos) == len(seen), f"大图底栏有不在 ACTION_ORDER 里的：{seen}"
    # 子集可以不同，但**对每一项都成立**的那几个动作，大图不能缺 ——
    # 缺一个就等于「在格子里能做、点进大图反而做不了」。
    for must in ("pick", "lock", "fav", "shot", "meta", "wf", "trash"):
        assert must in seen, f"大图底栏缺了 {must}，格子里有、点进去反而没有"

    # ③ 同一个动作在两处不能有两个名字。
    #    只看**给用户看的**文本（词典键 + t() 的参数）；注释里为了讲清历史
    #    还会提到旧叫法，那不算。
    body_only = "\n".join(
        ln for ln in src.split("\n") if not ln.lstrip().startswith("//"))
    for bad in ('t("选这个")', '"选这个":'):
        if bad in body_only:
            raise AssertionError("「选这个」和「用这张」是同一个动作，不能有两个叫法")
    if "「选这个」" in body_only:
        raise AssertionError("还有文案在提「选这个」，按钮已经统一叫「用这张」了")


def test_clicking_an_item_defaults_to_the_reversible_action():
    """点一下图片默认是「看大图」，不是「选中并关窗」。

    两件事的代价差着量级：选中会关掉窗口、改掉节点的值，误点一下要重新打开、
    重新找回原来那个位置；看大图按 Esc 就退，什么都没变。
    最容易触发的手势要留给可逆的那个。
    """
    src = _mediabrowser_js()
    m = re.search(r'loadStr\(CLICK_KEY,\s*"(\w+)"\)', src)
    if not m:
        raise AssertionError("找不到「点一下图片＝？」的默认值")
    assert m.group(1) == "view", f"默认是 {m.group(1)}，应当是看大图（view）"
    # 锚到「文件格子」那一个：文件夹格子的 onclick 缩进一模一样，find 会先撞上它
    i = src.find("if (lpFired) { lpFired = false; return; }")
    assert i > 0, "找不到文件格子的 onclick"
    body = src[i:i + 400]
    if "clickOpensViewer()" not in body or "openViewerAt" not in body:
        raise AssertionError("格子的单击必须按偏好走「看大图」这条路")
    # 想当纯选片器用的人要能换回去
    if 'class="clickact"' not in src:
        raise AssertionError("设置里缺「点一下图片＝」的开关")


def test_one_click_pick_still_has_a_target():
    """点图改成看大图之后，「一击选中」不能就此消失 —— 要有个明确的靶子。

    否则原来一下能做完的事变成两下，纯选片的用法直接被拖慢。
    这个靶子必须**看得出来跟别的按钮不一样**：它是这一项里唯一会关窗改值的动作。
    """
    src = _mediabrowser_js()
    k = src.find("const cellActionsFor")
    seg = src[k:src.find("const showMeta", k)]
    if 'id: "pick"' not in seg:
        raise AssertionError("动作清单里缺「用这张」")
    if "pickNow(path)" not in seg:
        raise AssertionError("「用这张」必须真的执行选中")
    if 'cls: "pick"' not in seg:
        raise AssertionError("「用这张」要带 pick 这个 class，否则配色不生效")
    # 操作条得真把 cls 挂到按钮上（光有 CSS 规则不算数，变异测试实测漏过）
    i = src.find('bar.className = "mb-bar"')
    if "a.cls" not in src[i:i + 600]:
        raise AssertionError("操作条没把 cls 挂到按钮上")
    if ".mb-cell .mb-bar button.pick{" not in src:
        raise AssertionError("「用这张」要有自己的配色 —— 一排一样的灰钮，点哪个都像在浏览")
    if ".mb-cellmenu .mi.pick" not in src:
        raise AssertionError("菜单里的「用这张」也要跟别的动作区分开")


def test_viewer_handles_kinds_that_have_no_picture():
    """点一下图片＝看大图之后，音频和 .md/.txt 这类也会被送进查看器。

    原来这里只有「视频 → video，其余 → img」两条路，音频和文本会渲染成裂图，
    再落进那句「浏览器播不了这个编码」—— 说的完全不是实情。
    """
    src = _mediabrowser_js()
    i = src.find("stage.innerHTML =")
    body = src[i:i + 1200]
    for need, why in (
        ('kind === "audio"', "音频要给 audio 播放器，不是裂图"),
        ("<audio", "音频要能播"),
        ('kind === "other"', "没法预览的类型要说清楚，而不是报「播不了这个编码」"),
    ):
        if need not in body:
            raise AssertionError(f"查看器缺 {need}：{why}")
    # 没有 img/video 时不能再去挂 onload，否则直接抛
    j = src.find("const media = stage.querySelector", i)
    if j < 0 or "if (!media)" not in src[j:j + 200]:
        raise AssertionError("音频 / 无预览类型没有媒体元素，必须早退，不能盲挂 onload")
    if 'stage.querySelector("video, audio")?.pause()' not in src:
        raise AssertionError("翻页要把音频也停掉，否则留个找不着源头的背景音")


def test_tap_does_not_count_as_a_long_press():
    """手指点一下**不能**触发长按菜单。

    抬手（pointerup）和「手指挪动」不能共用同一条判据 —— 曾经共用过，写成
    「挪动不到 10px 就不取消」，于是点一下（手指几乎不动）计时器活到底，
    500ms 后菜单照样弹出来：点一下变成了右键，实测踩中。
    """
    src = _mediabrowser_js()
    i = src.find("const stopLp")
    if i < 0:
        raise AssertionError("缺长按取消逻辑")
    body = src[i:i + 700]
    if '"pointerup"' not in body:
        raise AssertionError("抬手必须能取消长按")
    # 抬手那一路不许带距离判断
    up = re.search(r'for \(const e2 of \[([^\]]*)\]\)[\s\S]{0,120}?stopLp', body)
    if not up or "pointerup" not in up.group(1):
        raise AssertionError("pointerup 必须直接调 stopLp，不能走带距离判断的那条")
    if "Math.hypot" in src[i:src.find("pointerup", i)]:
        raise AssertionError("抬手不该再看手指挪了多远 —— 手指都离开了，那就是一次「点」")


def test_bar_and_menu_share_one_action_list():
    """悬停操作条和右键 / 「⋯」菜单必须**同一份清单**。

    分两处写的话迟早出现「条上有、菜单里没有」，两边看起来都正常，没人会发现；
    而触屏根本没有悬停，菜单是它够到全部操作的唯一入口 —— 漏一条就是缺功能。
    """
    src = _mediabrowser_js()
    if "const cellActionsFor" not in src:
        raise AssertionError("缺统一的动作清单 cellActionsFor")
    i = src.find('bar.className = "mb-bar"')
    if "cellActionsFor(it, c)" not in src[i:i + 500]:
        raise AssertionError("操作条必须照那份清单渲染，不能再自己一个个 mkBtn")
    j = src.find("const openCellMenu")
    if "cellActionsFor(it, cell)" not in src[j:j + 1500]:
        raise AssertionError("菜单必须照同一份清单渲染")
    # 每条都要答得上「点了会怎样」——菜单里有会关窗、会改值、会删文件的
    k = src.find("const cellActionsFor")
    seg = src[k:src.find("const showMeta", k)]
    ids = re.findall(r'id: "(\w+)"', seg)
    for need in ("pick", "view", "fav", "shot", "trash"):
        if need not in ids:
            raise AssertionError(f"动作清单里缺 {need}，实际有 {ids}")
    if seg.count("effect:") < len(ids):
        raise AssertionError("每个动作都要写明「点了确切发生什么」（effect）")


def test_html_buttons_declare_type_button():
    """模板里的 <button> 必须写 type="button"。

    HTML 默认 type=submit。点一下会提交祖先 <form> —— Comfy 前端把画布
    包在表单里、画布一脏就挂了 beforeunload，于是遮蔽菜单点「这张更严」
    会弹出浏览器的「要离开此网站吗？」。设置面板和确认框已经写了，
    宫格 / 大图 / 遮蔽菜单漏了。
    """
    src = _mediabrowser_js()
    bare = re.findall(r"<button(?![^>]*\btype\s*=)[^>]*>", src)
    assert not bare, (
        "这些 <button> 没写 type=，点了会当 submit：" +
        "；".join(b[:80] for b in bare[:6])
    )


def test_created_buttons_go_through_helper_that_sets_type():
    """createElement('button') 必须走会设 type=button 的辅助函数。

    运行时建的钮（格子底栏、揭开、跳过、类型筛选）同样默认 submit。
    """
    src = _mediabrowser_js()
    i = src.find("const mbElButton")
    assert i >= 0, "缺 mbElButton：运行时 createElement('button') 会是 submit"
    end = src.find("};", i)
    assert end > i, "mbElButton 辅助函数没找到结尾"
    body = src[i:end + 2]
    assert 'createElement("button")' in body, "mbElButton 应当是唯一的建钮处"
    assert 'type = "button"' in body, "mbElButton 必须设 type=button"
    rest = src[:i] + src[end + 2:]
    assert 'createElement("button")' not in rest, (
        "还有裸 createElement('button')，会漏掉 type=button")


def test_popstate_is_captured_and_swallowed_when_ours():
    """我们自己调的 history.back()，popstate 必须在捕获阶段拦住别的监听。

    Comfy 的 Vue Router 也听 popstate。不 stopImmediatePropagation 的话，
    关遮蔽菜单的那一格后退会被当成「离开当前页」，画布一脏就
    「要离开此网站吗？」。
    """
    src = _mediabrowser_js()
    i = src.find('addEventListener("popstate"')
    assert i >= 0, "缺 popstate 监听"
    chunk = src[i:i + 280]
    assert "stopImmediatePropagation" in chunk, (
        "popstate 监听必须 stopImmediatePropagation，把 Vue Router 挡在外面")
    assert ", true)" in chunk or ",true)" in chunk, (
        "必须挂在捕获阶段，否则 Vue Router 的冒泡监听会先跑")
    assert "onPop()" in chunk, "应当把事件交给 mbLayers.onPop"


def test_switching_pops_does_not_history_back_then_push():
    """从「⋯」进遮蔽、从大图进遮蔽，都不能 closePop 再立刻开新浮层。

    closePop → history.back() 是异步的，紧接着 armPopDismiss 又 pushState，
    两件事会打架：多退一格就把 Comfy 页面带走，点「这张更严」变成
    「要离开此网站吗？」。同一次交互里换浮层只拆 DOM，历史那一格留着。
    """
    src = _mediabrowser_js()
    assert "const teardownPopDom" in src, "缺拆浮层 DOM、不动历史的入口"
    for name, marker in (
        ("openCensorPanel", "const shell = makePopShell"),
        ("openCellMenu", "const actions = cellActionsFor"),
        ("showMeta", "document.body.appendChild(pop)"),
    ):
        i = src.find(f"const {name}")
        assert i >= 0, f"找不到 {name}"
        body = src[i:src.find(marker, i)]
        assert "closePop()" not in body, (
            f"{name} 开场还在 closePop()：会先 history.back 再 push，点菜单就离开网站")
        assert "teardownPopDom" in body, (
            f"{name} 换浮层应当只拆 DOM（teardownPopDom），别动历史")


def test_overlay_dismiss_uses_pointer_not_compat_mouse():
    """点遮罩关窗必须认 pointerdown，不能认合成的 mousedown。

    点浮层按钮之后浏览器会往「已经拆掉的浮层下面」补一发 mousedown，
    落点常常是遮罩 —— 整窗就被顺手关了。格子上的幽灵点击已经用
    pointerdown 判据挡过，遮罩和大图不能再用 mousedown 把洞留着。
    """
    src = _mediabrowser_js()
    assert 'mask.addEventListener("mousedown", (e) => { if (e.target === mask) close(); })' not in src, (
        "遮罩还在用 mousedown 关窗：点完菜单会合成 mousedown 把整窗关掉")
    assert 'mask.addEventListener("pointerdown"' in src, "遮罩关窗应当听 pointerdown"
    assert "lay.onmousedown" not in src, "大图点空白关窗不该再用 onmousedown（会吃合成鼠标事件）"


def test_outside_pointer_dismiss_does_not_fall_through():
    """点浮层外面关掉时，这一下不能落到下面的格子上。

    捕获阶段只 closePop、不拦住事件的话：pointerdown 会继续打到格子
    （downOn=true），随后 click 就当成「看大图 / 选中」。等于关菜单顺便
    点开一张图。
    """
    src = _mediabrowser_js()
    i = src.find("const armPopDismiss")
    assert i >= 0
    body = src[i:src.find("const pickNow", i)]
    on_down = body[body.find("const onDown"):body.find("const onKey")]
    assert "preventDefault" in on_down, "点外面关掉必须 preventDefault，否则还会合成 click"
    assert "stopPropagation" in on_down, "点外面关掉必须 stopPropagation，否则格子会记下这次按下"


def test_layers_are_registered_after_their_close_is_declared():
    """每个 mbLayers.push(X) 都必须排在 `const X =` 后面。

    反过来写会撞 TDZ（const 声明前访问直接抛 ReferenceError）。症状很阴：
    元素往往已经进了 DOM，所以「窗口看着是开了」，但那之后的接线一行都没跑 ——
    是个壳。这个坑一次踩了两处（浏览窗口和查看器），所以做成结构性检查。
    """
    src = _mediabrowser_js()
    pushes = [(m.start(), m.group(1)) for m in re.finditer(r"mbLayers\.push\((\w+)\)", src)]
    assert pushes, "一个层都没登记？后退键就没东西可关了"
    for at, name in pushes:
        decl = src.find(f"const {name} = ")
        assert decl >= 0, f"mbLayers.push({name}) 找不到 const {name} 的声明"
        assert decl < at, (
            f"mbLayers.push({name}) 排在 const {name} 前面 —— 运行到这里会抛 "
            f"ReferenceError，窗口打不开")


def test_thumb_reuses_a_bigger_tier_instead_of_redecoding():
    """出小档时，同一张图更大的那一档已经有了就从它缩，别再解码一遍原图。

    实测（真图 20 张 / 真视频 5 个，长边 1920~4608）：
      图片  从原图解码 中位 175ms  →  从已有的 1024 档缩 中位 27ms   快 6.5 倍
      视频  开 ffmpeg  中位 178ms  →  同上           中位 22ms   快 8 倍
    视频省得尤其多：免掉一次 ffmpeg 进程，光启动就 200~800ms。
    """
    import tempfile
    from PIL import Image

    tmp = tempfile.mkdtemp(prefix="mb-pyr-")
    try:
        src = os.path.join(tmp, "a.png")
        Image.new("RGB", (2000, 1000), (40, 90, 160)).save(src)
        st = os.stat(src)

        # 缓存里什么都没有：只能走原图
        assert mb.bigger_cached("output", "a.png", st, 384) is None

        # 放一份 1024 档进缓存，384 档就该找到它
        big = os.path.join(mb.CACHE_DIR, mb.thumb_key("output", "a.png", st, 1024) + ".webp")
        mb._make_thumb(src, big, 1024)
        try:
            assert mb.bigger_cached("output", "a.png", st, 384) == big
            # 只往大的方向找：从小的放大是骗人的
            assert mb.bigger_cached("output", "a.png", st, 1536) is None, "不能拿 1024 去做 1536"
            assert mb.bigger_cached("output", "a.png", st, 1024) is None, "同档不算「更大」"
            # 原像素档没有「更大的」，必须回原图
            assert mb.bigger_cached("output", "a.png", st, mb.THUMB_NATIVE) is None

            # 从大档缩出来的，尺寸要跟从原图缩出来的一样
            d1 = os.path.join(tmp, "from_src.webp")
            d2 = os.path.join(tmp, "from_base.webp")
            mb._make_thumb(src, d1, 384)
            mb._make_thumb(src, d2, 384, big)
            with Image.open(d1) as a, Image.open(d2) as b:
                assert a.size == b.size, f"两条路出来的尺寸不一样: {a.size} vs {b.size}"
        finally:
            try:
                os.remove(big)
            except OSError:
                pass
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_thumb_from_base_does_not_rotate_twice():
    """从缓存那份缩时**不能**再套一次 EXIF 旋转 —— 缓存里那份早就转正了，再转就歪。"""
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "__init__.py"), encoding="utf-8").read()
    i = src.find("def _make_thumb")
    body = src[i:i + 900]
    if "if base is None:" not in body:
        raise AssertionError("exif_transpose 必须只在「从原图来」时做")
    j = body.find("exif_transpose")
    if j < 0 or "if base is None:" not in body[:j]:
        raise AssertionError("exif_transpose 应当在 base is None 的分支里")
    # 有 base 时不能再去开 ffmpeg
    if "if base is None and src.lower().endswith(VID_EXT)" not in body:
        raise AssertionError("有现成的大档时，视频不该再开一次 ffmpeg")


def test_viewer_closes_on_clicking_the_picture():
    """点一下打开、再点一下关掉 —— 手不用跑去右上角找 ×。

    ⚠️ 只能认 <img>：视频和音频的点击归播放器管（暂停 / 拖进度条），
    抢过来就没法控制播放了。
    """
    src = _mediabrowser_js()
    i = src.find('stage.addEventListener("click"')
    if i < 0:
        raise AssertionError("查看器里点图片应当能关掉")
    body = src[i:i + 320]
    if '"IMG"' not in body:
        raise AssertionError("必须只认 <img>，否则会抢掉视频 / 音频的播放控制")
    if "shut()" not in body:
        raise AssertionError("点图片要真的关掉查看器")
    if "swiped" not in body:
        raise AssertionError("滑动翻页之后紧跟的那一发 click 必须挡掉，否则翻一下就关了")
    # 但标记不能一直留着：滑动后浏览器不一定补 click，留着会吃掉下一次真正的点击
    j = src.find('stage.addEventListener("pointerdown"')
    if "swiped = false" not in src[j:j + 400]:
        raise AssertionError("每次按下要清掉滑动标记，否则滑完之后「点一下关掉」会失灵一次")


def test_viewer_supports_swipe_on_touch():
    """触屏没有 ← → 键，滑动是唯一自然的翻页手势。

    阈值要挡住误触：横向位移够大、而且明显大于纵向 ——
    否则上下滚动和轻轻一蹭都会被当成翻页。
    """
    src = _mediabrowser_js()
    i = src.find('stage.addEventListener("pointerup"')
    if i < 0:
        raise AssertionError("查看器缺触屏滑动翻页")
    body = src[i:i + 500]
    if 'pointerType !== "touch"' not in body:
        raise AssertionError("滑动翻页只对手指生效，鼠标拖拽不该翻页")
    if "Math.abs(dx) < 45" not in body:
        raise AssertionError("缺横向位移阈值 —— 轻轻一蹭就翻页")
    if "Math.abs(dy)" not in body:
        raise AssertionError("缺「横向要明显大于纵向」的判据 —— 上下滚动会被当成翻页")


def test_viewer_prefetches_neighbours():
    """原图下完再预取邻居：一路往下翻是最常见的看法。

    只预取图片，中间夹视频就跳过。预取跟当前这张抢带宽会让第一次打开更慢。
    """
    src = _mediabrowser_js()
    i = src.find("const prefetch = ")
    if i < 0:
        raise AssertionError("查看器缺前后预取")
    body = src[i:i + 900]
    if "viewPrefetchPlan" not in body:
        raise AssertionError("预取名单必须走 viewPrefetchPlan（跳过视频、顺着翻多拿）")
    if 'fetchPriority = "low"' not in body:
        raise AssertionError("邻居预取必须是低优先级，不能跟当前这张抢")
    if "prefetch();" not in src:
        raise AssertionError("prefetch 定义了却没人调")
    show = src[src.find("const show = "):src.find("const go = ")]
    if "thumbOf" not in show:
        raise AssertionError("第一次打开应先垫格子里已缓存的缩略图")
    if 'fetchPriority = "high"' not in show:
        raise AssertionError("当前这张原图必须是高优先级")
    if "viewOrigReady" not in show or "prefetch();" not in show:
        raise AssertionError("原图就绪后才预取")
    vid = show[show.find('media.tagName === "VIDEO"'):show.find("const orig")]
    if "prefetch();" not in vid:
        raise AssertionError("视频不用等缓冲完，邻居图片仍要预取")


def test_viewer_keeps_last_frame_while_next_loads():
    """静图翻页必须留着上一张，下一张有像素再换。

    以前每次 innerHTML 清成空 <img> 再挂 src。原图几十 MB，缩略图来不及解码
    的那几帧就是黑屏；连点左右会一直黑。
    """
    src = _mediabrowser_js()
    show = src[src.find("const show = "):src.find("const go = ")]
    if '`<img alt="" draggable="false">`' in show:
        raise AssertionError("静图翻页不能先清成空 img，连点会黑屏")
    if "adopt(" not in show:
        raise AssertionError("下一张有像素再换到舞台上，上一张得留着")


def test_viewer_wheel_zooms():
    """大图滚轮放大缩小；放大后拖动；未放大时点图片仍关掉。"""
    src = _mediabrowser_js()
    if 'stage.addEventListener("wheel"' not in src:
        raise AssertionError("查看器缺滚轮缩放")
    i = src.find('stage.addEventListener("wheel"')
    body = src[i:i + 700]
    if "preventDefault" not in body:
        raise AssertionError("滚轮必须 preventDefault，否则会缩放整页 ComfyUI")
    if "viewZoomAfterWheel" not in body or "viewZoomTranslate" not in body:
        raise AssertionError("滚轮缩放必须走纯函数，对着光标放大")
    if "passive:false" not in body.replace(" ", ""):
        raise AssertionError("wheel 监听必须 passive:false，否则 preventDefault 无效")
    click = src[src.find('stage.addEventListener("click"'):src.find('stage.addEventListener("wheel"')]
    if "viewClickCloses" not in click:
        raise AssertionError("放大后点图片不能关；未放大才关")
    if "resetZoom()" not in src[src.find("const show = "):src.find("const go = ")]:
        raise AssertionError("换图必须把缩放清掉，否则下一张还歪着")


def test_preload_asks_then_fetches_current_filter():
    """当前筛选的原图可一次性预加载：先问、只 2 路、走 /api/view、不锁窗口。

    列表可能有几千张。锁界面会让人以为卡死；把解码图全堆内存会把标签页打爆。
    复用查看器那条 /api/view，blob 读完即丢，只暖 HTTP/磁盘缓存。
    """
    src = _mediabrowser_js()
    if 'data-act="preload"' not in src:
        raise AssertionError("顶栏缺预加载按钮")
    ops = src[src.find('class="mb-top-row mb-top-ops"'):src.find('class="mb-crumbrow"')]
    if ops.find('data-act="preload"') < 0 or ops.find('data-act="preload"') > ops.find('data-act="shot-box"'):
        raise AssertionError("预加载按钮应在第二行、整窗截图左边")
    i_ask = src.find("const askAndStartPreload")
    ask = src[i_ask:i_ask + 900]
    if "viewPreloadPaths(show)" not in ask:
        raise AssertionError("必须预加载当前筛选 show，不能用未筛的 items")
    if "await confirmPreload" not in ask:
        raise AssertionError("一点就开始会卡住很久，必须先二次确认")
    if ask.find("confirmPreload") > ask.find("startPreload(paths)"):
        raise AssertionError("确认必须在真正拉文件之前")
    start = src[src.find("const startPreload"):src.find("const askAndStartPreload")]
    if "runViewPreload" not in start:
        raise AssertionError("全量加载必须走 runViewPreload，复用查看器那条 /api/view")
    if "new Image" in start or "rememberDecoded" in start:
        raise AssertionError("全量加载不能把原图解码对象堆进内存")
    if "/mediabrowser/thumb" in start:
        raise AssertionError("全量加载不能去拉缩略图充数")
    if ".mb-preloading" in src or "mb-box.mb-preloading" in src:
        raise AssertionError("预加载不能锁窗口；任务可能要数分钟")
    conf = src[src.find("const confirmPreload"):src.find("const staleBackend")]
    if 'class="do"' not in conf or 'class="go"' in conf:
        raise AssertionError("预加载确认要用蓝钮，不能用回收站那种红的")
    if "开始预加载" not in conf:
        raise AssertionError("确认框主按钮要写清点了会开始预加载")
    body = src[src.find("// 全量预加载"):src.find("// ── 大图查看结束")]
    if 'priority: "low"' not in body or 'cache: "force-cache"' not in body:
        raise AssertionError("预加载必须低优先级，并且尽量走浏览器缓存")
    if "VIEW_PRELOAD_CONCUR = 2" not in body:
        raise AssertionError("全量加载同时只拉 2 张，避免把机器打满")
    close = src[src.find("const close = () => {"):src.find("mbLayers.push(close)")]
    if "preloadAbort" not in close:
        raise AssertionError("关窗必须打断还在飞的预加载")
    if 'stopPreload("scope")' not in src:
        raise AssertionError("筛选或目录变了必须停下预加载，避免对着旧名单空转")
    if 'stopPreload("user")' not in src:
        raise AssertionError("跑起来再点同一按钮应取消")


def test_detection_does_not_starve_thumbnails():
    """局部检测必须走**自己的**线程池，不能跟缩略图抢工位。

    ORT 的 session.run 被 censor.py 的 _run_lock 串成一条队（同一个 session
    不能并发跑），于是一屏 20 多张图的检测请求全挤在锁上等 ——
    而它们等锁时**占着线程池的线程**。8 个工位被等锁的检测占满，
    缩略图一张都出不来。
    实测（24 张真图 · 一屏 · 512 档）：只要缩略图 0.61s；同时要检测框 15.12s，
    慢 25 倍 —— 这就是「点开半天不出图，以为崩溃了」。
    """
    src = _init_py()
    if "_CENSOR_POOL" not in src:
        raise AssertionError("缺检测专用线程池")
    i = src.find("async def mediabrowser_regions")
    body = src[i:i + 1400]
    if "_CENSOR_POOL" not in body:
        raise AssertionError("/regions 还在用 _POOL —— 会把缩略图饿死")
    if "run_in_executor(_POOL" in body:
        raise AssertionError("/regions 不能再走 _POOL")


def test_webp_encode_is_not_left_on_the_slow_default():
    """大档位的时间几乎全花在 webp 编码上，别用 Pillow 的慢默认值。

    实测同批 20 张真图（1424×1280）：解码 12ms，而 1536 档编码 137ms。
      method=4（默认） 512 档 19.8ms / 1536 档 136.6ms
      method=2        512 档  8.8ms / 1536 档  50.8ms   快 2.2~2.7 倍，体积 +3%
      method=1/0      再快些，但体积 +22~31% —— 局域网 / 手机上反而更慢
    """
    assert hasattr(mb, "THUMB_METHOD"), "缺 THUMB_METHOD"
    assert mb.THUMB_METHOD == 2, (
        f"THUMB_METHOD={mb.THUMB_METHOD}：0/1 体积涨太多，4/6 太慢，实测 2 最划算")
    src = _init_py()
    if "method=THUMB_METHOD" not in src:
        raise AssertionError("定义了 THUMB_METHOD 却没传给 im.save")


def test_cursor_tells_you_what_the_click_will_do():
    """鼠标样式是「点下去会发生什么」的预告，必须跟着设置走。

    点一下＝看大图 → 放大镜(+)；点一下＝直接选中 → 普通手型；
    进了大图，图片上是放大镜(−)，跟进来的动作对称。
    文件夹永远手型 —— 它是「进去」，跟放大没关系。
    """
    src = _mediabrowser_js()
    for need, why in (
        (".mb-box.click-view .mb-cell:not(.dir){cursor:zoom-in;}", "看大图模式要放大镜(+)"),
        (".mb-box.click-pick .mb-cell:not(.dir){cursor:pointer;}", "直接选中模式要手型"),
        (".mb-play .mb-stage img{cursor:zoom-out;}", "大图里图片上要放大镜(−)"),
        ("syncClickMode", "设置改了鼠标样式要立刻跟上"),
    ):
        if need not in src:
            raise AssertionError(f"缺 {need}：{why}")
    # 设置面板改完必须调一次，否则要重开窗口才生效
    i = src.find("clickSel.onchange")
    if "syncClickMode()" not in src[i:i + 300]:
        raise AssertionError("改完设置没同步鼠标样式")


def test_local_mode_blurs_first_then_refines():
    """局部模式下，检测框还没回来的那一张必须**先糊着**，不能先把原图亮出来。

    先亮原图看着更快，但一屏 24 张检测要十几秒（实测服务端约 0.6s/张，
    而且 ORT 的 run 是串行的）—— 那十几秒等于遮蔽根本没开，
    而遮蔽存在的理由正是「别把原图亮出来」。
    代价接近零：糊是纯 CSS，瞬时；框到了立刻摘掉换成精确遮蔽。
    """
    src = _mediabrowser_js()
    if ".mb-cell.censor-wait img{filter:blur" not in src:
        raise AssertionError("缺「等检测时先糊着」的样式")
    if ".mb-cell.censor-wait.peek img{filter:none" not in src:
        raise AssertionError("糊着也得能点眼睛看一眼，否则没有出路")
    i = src.find("const applyLocalCaches")
    body = src[i:i + 1400]
    if 'el.classList.add("censor-wait")' not in body:
        raise AssertionError("没有框的那一张要挂上等待态")
    if 'el.classList.remove("censor-wait")' not in body:
        raise AssertionError("框到了要摘掉等待态，否则一直糊着")
    # 跳过河蟹 / 整张糊 的不该被等待态盖住
    j = body.find("isSkipDetect(path)")
    if 'remove("censor-wait")' not in body[j:j + 260]:
        raise AssertionError("「跳过河蟹」标过的不该再挂等待态 —— 你已经说过那张不用管")
    # 检测完但没有要遮的部位，也要摘掉，否则干净的图一直糊着
    # 检测完但没有要遮的部位，也要摘掉，否则干净的图一直糊着
    if 'rec.reason !== "failed"' not in src:
        raise AssertionError("检测完确认没有要遮的部位时，也必须摘掉等待态")


def test_no_dangling_constant_references():
    """全大写常量必须都有定义。

    这是**只有跑起来才会炸**的一类错：删掉一个 const、漏改一处引用，
    `node --check` 照样过（语法没问题）、所有查源码的测试也照样过，
    直到用户点开浏览窗口才 ReferenceError。
    实际踩过：CELL_ACTION_COUNT 删了，syncSize 里还留着一处引用，
    表现为「点浏览资源没反应」。
    前端是单文件、没有打包器和 linter，这条就是那道闸。
    """
    src = _mediabrowser_js()
    # 只认**带下划线**的全大写名字 —— 那是本项目常量的写法（THUMB_PX_KEY 这种）。
    # 检测框的标签（FEMALE_BREAST_EXPOSED…）长得一样，但它们只出现在引号里，
    # 所以下面按「有没有一次是不带引号出现的」来区分：不带引号才算真的当标识符用。
    body = re.sub(r"\/\*.*?\*\/", "", src, flags=re.S)          # 去掉 /* */ 块注释
    # 行尾注释也要去（`const X = 1;  // 跟后端 CACHE_FLOOR 对齐` 这种）。
    # 前面不许是冒号，免得把 https:// 的双斜杠当成注释、把整行截断。
    body = re.sub(r"(?<![:])//.*$", "", body, flags=re.M)
    declared = set(re.findall(
        r"\b(?:const|let|var|function)\s+([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b", body))
    used = set()
    for m in re.finditer(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b", body):
        before = body[m.start() - 1] if m.start() else ""
        after = body[m.end()] if m.end() < len(body) else ""
        # 引号里的是文本（检测标签 FEMALE_BREAST_EXPOSED 那些），
        # 冒号前的是对象的键（CENSOR_LABEL_NAME 那张表）—— 都不算「当标识符在用」。
        if before in ("\"", "'"):
            continue
        if after in ("\"", "'", ":"):
            continue
        used.add(m.group(0))
    missing = sorted(used - declared)
    if missing:
        raise AssertionError(f"这些常量用了但没定义（跑起来会 ReferenceError）：{missing}")


def test_per_image_tuning_is_stored_apart_and_clearable():
    """单张的「打码范围 / 糊的程度」另存一个键，不挤进 CENSOR_ONE_KEY。

    CENSOR_ONE_KEY 里已经存着两种形态（字符串档位 / 自选部位数组）；
    再往里塞对象就得给已有数据做迁移，而迁移错了是**静默**的 ——
    用户看到的只是「我调过的那张怎么回去了」。
    另外它跟收藏/跳过一样是按路径存、只增不减，必须能被「清标记」清掉。
    """
    src = _mediabrowser_js()
    if "CENSOR_TUNE_KEY" not in src:
        raise AssertionError("缺单张微调的存储键")
    i = src.find("const MARK_KEYS")
    if "CENSOR_TUNE_KEY" not in src[i:i + 220]:
        raise AssertionError("CENSOR_TUNE_KEY 没登记进 MARK_KEYS，「清标记」清不掉它")
    # 四条滑块从**一张表**生成：加一条只改表，渲染和接线不用动
    m = re.search(r"const CENSOR_TUNE_FIELDS = \[(.*?)\n\];", src, re.S)
    if not m:
        raise AssertionError("缺 CENSOR_TUNE_FIELDS —— 四条滑块应当从一张表生成")
    keys = re.findall(r'key: "(\w+)"', m.group(1))
    assert set(keys) == {"thr", "cover", "breast", "blur"}, f"滑块字段不齐: {keys}"
    # 规则要把画法三项带下去，否则调了不生效
    j = src.find("const censorRuleFor")
    seg = src[j:j + 1400]
    for k in ("tune.cover", "tune.breast", "tune.blur"):
        if k not in seg:
            raise AssertionError(f"censorRuleFor 没把单张的 {k} 带进规则")
    # 判定类要**盖过**档位算出来的 thr —— 滑块是明确点的，比档位的推断更该算数
    if "if (tune.thr != null) r.thr" not in seg:
        raise AssertionError("单张灵敏度没有盖过档位的 thr，调了不生效")
    # 胸部那一项必须只作用在胸部标签上，不能把下体的框一起改了
    i2 = src.find("const coverFor")
    if 'BREAST_LABELS.has(label) ? pick("breast"' not in src[i2:i2 + 300]:
        raise AssertionError("单张胸部缩放必须只作用于胸部标签")
    # 画的时候要认这两个值
    if "coverFor(b.label, rule)" not in src:
        raise AssertionError("visibleBoxes 没把 rule 传给 coverFor，单张范围不会生效")
    if 'rule.blur != null) layer.style.setProperty' not in src:
        raise AssertionError("paintCensorOverlay 没按单张糊度设 CSS 变量")
    # 内存缓存也要跟着清，否则清完还按旧值画
    k = src.find("const forgetClientMarks")
    if "censorTuneCache = null" not in src[k:k + 260]:
        raise AssertionError("清标记时没清 censorTuneCache，清完还会按旧值画")


def test_peek_state_class_never_collides_with_the_button():
    """舞台的「正在看一眼」状态类不能和眼睛按钮同名。

    真踩过：两边都叫 peek，而舞台在 DOM 里排在底栏**前面**，
    `lay.querySelector(".peek")` 于是先撞上舞台；setIco 把舞台的 innerHTML
    整个换成一个眼睛图标 —— 图片当场消失，再点也回不来。
    这类错静态测试看不出来（选择器语法没问题），只有真点一下才炸。
    """
    src = _mediabrowser_js()
    # 舞台用 peeking，按钮用 .act.peek，两者必须分开
    if 'stage.classList.toggle("peek")' in src:
        raise AssertionError("舞台的状态类又叫回 peek 了，会跟按钮撞名")
    if "peeking" not in src:
        raise AssertionError("舞台的状态类应当叫 peeking")
    # 注释里提到旧写法不算，只看真代码
    for line in src.split("\n"):
        if line.lstrip().startswith("//"):
            continue
        if "querySelector(\".peek\")" in line:
            raise AssertionError("按钮要用 .act.peek 取，裸 .peek 会先撞上舞台")
    # CSS 也要跟着改，否则「看一眼」根本不生效
    if ".mb-play .mb-stage.peeking img" not in src:
        raise AssertionError("CSS 里舞台的 peeking 规则没跟上")


def _run_all():
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    bad = 0
    for n, f in fns:
        try:
            f()
            print(f"  PASS  {n}")
        except Exception as e:
            bad += 1
            print(f"  FAIL  {n}: {e}")
    print(f"\n  {len(fns) - bad}/{len(fns)} passed")
    return bad


if __name__ == "__main__":
    sys.exit(1 if _run_all() else 0)
