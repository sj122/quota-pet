'use strict';

const fs = require('fs');
const path = require('path');

// 极简 JSON 文件存储：读失败回落默认值，写入先写临时文件再改名，避免写一半断电损坏。
class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return structuredClone(this.fallback);
    }
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const text = JSON.stringify(data, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 改名可能被杀毒软件占用或文件系统限制挡住（EPERM / EXDEV），退回直接覆盖写
      try {
        fs.unlinkSync(tmp);
      } catch {}
      fs.writeFileSync(this.file, text, 'utf8');
    }
  }
}

module.exports = { JsonFile };
