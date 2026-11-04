// fixture：长驻进程（供 cancel / 杀进程组测试）
process.stdout.write('ready\n');
setInterval(() => {}, 1000);
