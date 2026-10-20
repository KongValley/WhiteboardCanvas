// SPDX-License-Identifier: GPL-3.0-or-later
// 更新性能基线（记录优化后的水平）
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'test', 'bench-baseline.json');
const latest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'bench-latest.json'), 'utf8'));
fs.writeFileSync(file, JSON.stringify(latest, null, 2) + '\n', 'utf8');
console.log('baseline updated');
console.log(JSON.stringify(latest, null, 2));
