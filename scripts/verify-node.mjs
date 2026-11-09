#!/usr/bin/env node
/**
 * 根 package.json engines（>=20）与原生模块（better-sqlite3 / SEA）前置检查。
 */
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`✘ 需要 Node >= 20（当前 ${process.versions.node}）。安装：nvm install 20 && nvm use`);
  process.exit(1);
}
