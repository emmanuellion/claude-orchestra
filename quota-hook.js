#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.rate_limits) {
      const file = path.join(os.homedir(), '.claude', 'orchestra-quota.json');
      fs.writeFileSync(file, JSON.stringify({
        five_hour: data.rate_limits.five_hour || null,
        seven_day: data.rate_limits.seven_day || null,
        model: data.model || null,
        cost: data.cost || null,
        updated: Date.now(),
      }));
    }
  } catch {}
});
