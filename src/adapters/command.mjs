import { spawn } from 'node:child_process';

const SAFE_ENV_KEYS = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NODE_EXTRA_CA_CERTS',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'Path',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PSMODULEPATH',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'USERPROFILE',
  'WINDIR'
]);

export class CommandTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Command exceeded the ${timeoutMs} ms deadline`);
    this.name = 'CommandTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export function createSafeEnv(source = process.env, additions = {}) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (SAFE_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(additions)) {
    if (SAFE_ENV_KEYS.has(key.toUpperCase()) && typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function stopProcess(child) {
  if (!child.pid || child.killed) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    killer.unref();
    return;
  }
  child.kill('SIGKILL');
}

export function runCommand({
  command,
  args = [],
  input = '',
  cwd,
  timeoutMs = 120_000,
  maxOutputBytes = 4 * 1024 * 1024,
  env = createSafeEnv(),
  signal
}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };

    const onAbort = () => {
      stopProcess(child);
      finish(reject, new Error('Command cancelled'));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopProcess(child);
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const collect = (target, chunk) => {
      const next = target + chunk;
      if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
        outputExceeded = true;
        stopProcess(child);
      }
      return next;
    };

    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });

    child.once('error', (error) => finish(reject, error));
    child.once('close', (exitCode, terminationSignal) => {
      if (timedOut) {
        finish(reject, new CommandTimeoutError(timeoutMs));
        return;
      }
      if (outputExceeded) {
        finish(reject, new Error(`Command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      finish(resolve, { exitCode, terminationSignal, stdout, stderr });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

export function extractJsonObject(text) {
  if (typeof text !== 'string') {
    throw new Error('Provider did not return text containing a valid JSON object');
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);

  try {
    const parsed = JSON.parse(candidate.trim());
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error('Provider did not return text containing a valid JSON object');
  }
}
