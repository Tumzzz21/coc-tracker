// Boot probe: spawns the server, watches it briefly, reports what happened.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const child = spawn('node', ['server.js'], { cwd: __dirname, shell: false });
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { err += d; });

const report = (verdict) => {
  const lines = [verdict, '--- STDOUT ---', out.trim() || '(none)', '--- STDERR ---', err.trim() || '(none)'];
  fs.writeFileSync(path.join(__dirname, 'boot-report.txt'), lines.join('\n'));
  process.exit(0);
};

child.on('exit', (code) => report(`EXITED early with code ${code}`));
setTimeout(() => {
  report(child.exitCode === null ? 'STILL RUNNING (booted and listening)' : `EXITED code ${child.exitCode}`);
}, 2500);
