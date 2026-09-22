/**
 * 抽出 mediabrowser.js 里 PNG_STRIP 段，真跑剥 tEXt/iTXt/zTXt。
 * 跑法: node tests/run_png_strip.mjs web/mediabrowser.js
 */
import fs from "fs";
import vm from "vm";

const srcPath = process.argv[2];
if (!srcPath) {
  console.error("用法: node run_png_strip.mjs <mediabrowser.js>");
  process.exit(2);
}
const src = fs.readFileSync(srcPath, "utf8");
const m = src.match(/\/\* PNG_STRIP_BEGIN \*\/([\s\S]*?)\/\* PNG_STRIP_END \*\//);
if (!m) {
  console.error("mediabrowser.js 缺少 PNG_STRIP_BEGIN/END 段");
  process.exit(1);
}
const ctx = {};
vm.runInNewContext(
  m[1] + `
    this.stripPngTextChunks = stripPngTextChunks;
  `,
  ctx,
);

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  return Buffer.concat([len, Buffer.from(type, "ascii"), data, crc]);
};

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = chunk("IHDR", Buffer.alloc(13));
const text = chunk("tEXt", Buffer.from("workflow\0{\"nodes\":[]}"));
const itxt = chunk("iTXt", Buffer.from("prompt\0\0\0\0{}"));
const ztxt = chunk("zTXt", Buffer.from("foo\0\0bar"));
const phys = chunk("pHYs", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 1]));
const idat = chunk("IDAT", Buffer.from([1, 2, 3, 4]));
const iend = chunk("IEND", Buffer.alloc(0));

const withText = Buffer.concat([sig, ihdr, text, itxt, phys, ztxt, idat, iend]);
const stripped = Buffer.from(ctx.stripPngTextChunks(new Uint8Array(withText)));
if (stripped.includes(Buffer.from("workflow")) || stripped.includes(Buffer.from("prompt"))) {
  fail("剥完还留着 workflow/prompt 文本");
}
if (!stripped.subarray(0, 8).equals(sig)) fail("签名丢了");
if (!stripped.includes(Buffer.from("IHDR"))) fail("IHDR 不该丢");
if (!stripped.includes(Buffer.from("IDAT"))) fail("IDAT 不该丢");
if (!stripped.includes(Buffer.from("pHYs"))) fail("pHYs 不该丢");
if (!stripped.includes(Buffer.from("IEND"))) fail("IEND 不该丢");
if (stripped.includes(Buffer.from("tEXt")) || stripped.includes(Buffer.from("iTXt")) ||
    stripped.includes(Buffer.from("zTXt"))) {
  fail("文本块类型还在");
}

const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
const jpegOut = Buffer.from(ctx.stripPngTextChunks(new Uint8Array(jpeg)));
if (!jpegOut.equals(jpeg)) fail("非 PNG 应原样返回");

const clean = Buffer.concat([sig, ihdr, phys, idat, iend]);
const cleanOut = Buffer.from(ctx.stripPngTextChunks(new Uint8Array(clean)));
if (!cleanOut.equals(clean)) fail("没有文本块时应字节不变");

console.log("ok");
