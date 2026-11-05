// fixture：模拟 `--version` 输出——打印 argv[2]（调用方把版本串放这里）后退出 0
process.stdout.write(`${process.argv[2] ?? ''}\n`);
