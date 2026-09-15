# -*- coding: utf-8 -*-
"""端到端验证：走**真实的 /mediabrowser/list 处理函数**，不是直接调内部助手。

验四件事：
  1. 耗时功能还能用（history 对上 → 列表里返回 elapsed）
  2. 一个文件都没被改（逐个 SHA256 + mtime + size 比对）
  3. 老图身上早期版本写进 PNG 的 elapsed 仍然读得回来
  4. 改名之后耗时还跟着文件走

跑法：python verify_elapsed.py
用的是 output 里真实图片的**副本**，不动你的原文件。
"""
import asyncio
import hashlib
import os
import shutil
import sys
import tempfile
import types

# 仓库根 = 本文件的上一级（tools/ 就在仓库根下）。
# 别写死绝对路径 —— 那样换台机器、换个安装位置就跑不起来。
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)


def _default_src() -> str:
    """猜 ComfyUI 的 output/：插件通常装在 ComfyUI/custom_nodes/<插件>/ 下。"""
    guess = os.path.join(os.path.dirname(os.path.dirname(REPO)), "output")
    return guess if os.path.isdir(guess) else ""


# 样本来源，优先级：命令行第一个参数 > MB_VERIFY_SRC 环境变量 > 猜 output/。
# 一张真图都找不到时会自己造几张，验证照跑，只是说服力弱一点 ——
# 「没动过用户的文件」这一条，拿真图验才算数。
SRC_DIR = (
    (sys.argv[1] if len(sys.argv) > 1 else "")
    or os.environ.get("MB_VERIFY_SRC", "")
    or _default_src()
)

SANDBOX = tempfile.mkdtemp(prefix="mb-verify-")
for k in ("input", "output", "temp"):
    os.makedirs(os.path.join(SANDBOX, k), exist_ok=True)

fp = types.ModuleType("folder_paths")
for k in ("input", "output", "temp"):
    setattr(fp, f"get_{k}_directory", lambda k=k: os.path.join(SANDBOX, k))
sys.modules.setdefault("folder_paths", fp)

_HISTORY = {}


class _Routes:
    def get(self, *a, **k):
        return lambda f: f

    def post(self, *a, **k):
        return lambda f: f


class _Queue:
    def get_history(self, *a, **k):
        return _HISTORY


srv = types.ModuleType("server")
srv.PromptServer = type("PS", (), {
    "instance": types.SimpleNamespace(routes=_Routes(), prompt_queue=_Queue())})
sys.modules.setdefault("server", srv)

import __init__ as mb                                   # noqa: E402
from PIL import Image                                   # noqa: E402
from PIL.PngImagePlugin import PngInfo                  # noqa: E402


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for blk in iter(lambda: f.read(1 << 20), b""):
            h.update(blk)
    return h.hexdigest()


def snapshot(d):
    out = {}
    for root, _dirs, files in os.walk(d):
        for f in files:
            p = os.path.join(root, f)
            st = os.stat(p)
            out[p] = (sha(p), st.st_mtime_ns, st.st_size)
    return out


class _Req:
    def __init__(self, **q):
        from urllib.parse import urlencode
        import yarl
        self.rel_url = yarl.URL("/?" + urlencode(q))


ok = True


def check(name, cond, extra=""):
    global ok
    print(f"  {'✓' if cond else '✗'} {name}" + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        ok = False


out = os.path.join(SANDBOX, "output")

# ── 准备样本 ──────────────────────────────────────────────
picked = []
if SRC_DIR and os.path.isdir(SRC_DIR):
    for root, _d, files in os.walk(SRC_DIR):
        for f in files:
            if f.lower().endswith(".png"):
                picked.append(os.path.join(root, f))
        if len(picked) >= 6:
            break
for i, real in enumerate(picked[:4]):
    shutil.copy2(real, os.path.join(out, f"real{i}.png"))
synthetic = not picked
if synthetic:
    print(f"× 没在 {SRC_DIR or '(没给样本目录)'} 里找到 PNG —— 改用现造的图。")
    print("  想拿真图验（更有说服力）：python verify_elapsed.py <你的 output 目录>")
    for i in range(4):
        Image.new("RGB", (64 + i, 48 + i), (i * 40, 90, 200)).save(
            os.path.join(out, f"real{i}.png"))

# 一张「老图」：身上带着早期版本写进 PNG 的 elapsed 文本块
old = os.path.join(out, "legacy.png")
info = PngInfo()
info.add_text("elapsed", "77.5")
Image.new("RGB", (32, 24), (9, 9, 9)).save(old, pnginfo=info)

print(f"沙箱: {SANDBOX}")
print("样本: %d 张（4 张%s + 1 张带旧 elapsed 块的）\n"
      % (len(os.listdir(out)), "现造的图" if synthetic else "真图副本"))

before = snapshot(out)

# ── ① 走真实 list 路径，history 里给一张图配上耗时 ────────────
target = "real0.png"
_HISTORY.clear()
_HISTORY["job-1"] = {
    "status": {"messages": [
        ["execution_start", {"timestamp": 1000}],
        ["execution_success", {"timestamp": 43500}],
    ]},
    "outputs": {"9": {"images": [{"filename": target, "subfolder": "", "type": "output"}]}},
}

print("① 走真实的 mediabrowser_list 处理函数")
resp = asyncio.run(mb.mediabrowser_list(_Req(type="output", sort="time_desc")))
import json                                              # noqa: E402
body = json.loads(resp.text)
el = body.get("elapsed") or {}
check("列表返回了 elapsed", bool(el), f"elapsed={el}")
check(f"{target} 的耗时对上了 42.5s", abs(el.get(target, 0) - 42.5) < 0.05, f"拿到 {el.get(target)}")
check("老图的 elapsed 也读出来了（早期写进 PNG 的）",
      abs(el.get("legacy.png", 0) - 77.5) < 0.05, f"拿到 {el.get('legacy.png')}")

# ── ② 一个字节都没动 ─────────────────────────────────────
print("\n② 文件有没有被改（SHA256 + mtime + size 逐个比）")
after = snapshot(out)
changed = [p for p in before if p in after and before[p] != after[p]]
added = sorted(set(after) - set(before))
check("所有文件的 SHA256 / mtime / size 全部不变", not changed,
      f"被改的: {[os.path.basename(p) for p in changed]}")
check("没有在图片目录里新增任何文件（.part 之类）", not added,
      f"多出来: {[os.path.basename(p) for p in added]}")

# ── ③ 索引落在插件缓存里，不在用户目录 ─────────────────────
print("\n③ 索引存在哪")
check("索引在插件的缓存目录里", mb.ELAPSED_INDEX.startswith(mb.CACHE_DIR),
      mb.ELAPSED_INDEX)
check("索引文件真的生成了", os.path.isfile(mb.ELAPSED_INDEX))

# ── ④ 改名之后耗时还跟着走 ───────────────────────────────
print("\n④ 改名之后耗时还在吗")
src_p = os.path.join(out, target)
dst_p = os.path.join(out, "renamed-by-user.png")
os.rename(src_p, dst_p)
resp2 = asyncio.run(mb.mediabrowser_list(_Req(type="output", sort="time_desc", refresh="1")))
el2 = json.loads(resp2.text).get("elapsed") or {}
check("改名后仍能查到 42.5s", abs(el2.get("renamed-by-user.png", 0) - 42.5) < 0.05,
      f"拿到 {el2.get('renamed-by-user.png')}")

print("\n" + ("全部通过" if ok else "有不通过项"))
shutil.rmtree(SANDBOX, ignore_errors=True)
sys.exit(0 if ok else 1)
