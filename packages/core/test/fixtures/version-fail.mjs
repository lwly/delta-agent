// fixture：stderr 抱怨后非零退出（探测失败路径）
process.stderr.write('external-cli: not available in test environment\n');
process.exit(1);
