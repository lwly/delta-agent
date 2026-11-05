// F-56 GBK 输出 fixture：模拟中文 Windows 下 cmd shim / 控制台按本地码页（cp936）
// 写出的错误文本——字节序列 = '不是内部或外部命令，也不是可运行的程序'.encode('gbk')。
// delta 以 UTF-8 严格解码该字节流必然出现 U+FFFD → 触发 GBK 回退解码（spawn.ts decodeLineBuffer）。
const GBK_BYTES = [
  178, 187, 202, 199, 196, 218, 178, 191, 187, 242, 205, 226, 178, 191, 195, 252,
  193, 238, 163, 172, 210, 178, 178, 187, 202, 199, 191, 201, 212, 203, 208, 208,
  181, 196, 179, 204, 208, 242,
];
process.stderr.write(Buffer.from(GBK_BYTES));
process.stderr.write('\n');
process.exit(1);
