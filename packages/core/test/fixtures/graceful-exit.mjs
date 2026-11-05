// fixture：长驻进程，收到 SIGTERM 后自然退出（供 onAbort 先于强杀测试）
process.on('SIGTERM', () => process.exit(0));
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
