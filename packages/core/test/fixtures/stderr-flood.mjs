// fixture：输出 500 行 stderr（验证环形缓冲只留最近 200 行）
for (let i = 0; i < 500; i++) {
  console.error(`err-${i}`);
}
