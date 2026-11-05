// fixture：把子进程收到的完整环境变量打印成一行 JSON（供 env 白名单断言）
process.stdout.write(JSON.stringify(process.env) + '\n');
