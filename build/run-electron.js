const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

function isWsl() {
  if (process.platform !== 'linux') {
    return false;
  }

  return os.release().toLowerCase().includes('microsoft') || Boolean(process.env.WSL_DISTRO_NAME);
}

const electronBinary = path.join(__dirname, '..', 'node_modules', 'electron', 'cli.js');
const args = [electronBinary, '.'];

if (isWsl()) {
  args.push('--no-sandbox');
}

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: process.env
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

