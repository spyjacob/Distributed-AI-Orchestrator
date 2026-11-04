// Stop only this checkout's Node server; never kill an arbitrary port occupant.
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree } from '../src/core/platform.js';

const powershell = (command) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
  { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();

export function listeners(port) {
  if (process.platform === 'win32') {
    return [...new Set(powershell(`@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue).OwningProcess`)
      .split(/\s+/).filter(Boolean))];
  }
  try {
    return [...new Set(execFileSync('lsof', ['-nP', '-a', '-iTCP:' + port, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/).filter(Boolean))];
  } catch (e) {
    if (e.status === 1 && !String(e.stdout || '').trim()) return [];
    // Not every Linux has lsof; ss comes with its basic networking tools.
    if (e.code === 'ENOENT' && process.platform === 'linux') {
      const found = execFileSync('ss', ['-ltnpH', `sport = :${Number(port)}`], { encoding: 'utf8', timeout: 3000 });
      return [...new Set([...found.matchAll(/pid=(\d+)/g)].map((match) => match[1]))];
    }
    throw e;
  }
}

// The command line (and working directory where the OS exposes it) of a listener.
function describe(pid) {
  if (process.platform === 'win32') {
    return { command: powershell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`), cwd: null };
  }
  if (process.platform === 'linux') {
    return { command: readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').split('\0').filter(Boolean), cwd: readlinkSync(`/proc/${Number(pid)}/cwd`) };
  }
  const command = execFileSync('ps', ['-p', pid, '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
  const fields = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 3000 });
  return { command, cwd: fields.split('\n').find((line) => line.startsWith('n'))?.slice(1) };
}

// command is an argv array or a command line; Windows quotes paths containing spaces.
export function matchesServer(command, cwd, root) {
  const parts = Array.isArray(command) ? command
    : [...command.trim().matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  if (!/^node(?:js)?(?:\.exe)?$/i.test(path.win32.basename(parts[0] || ''))) return false;
  try {
    // Started through boot.js now; a server from before the update ran index.js directly.
    const servers = ['server/boot.js', 'server/index.js'].map((file) => { try { return realpathSync(path.join(root, file)); } catch { return null; } }).filter(Boolean);
    const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    return parts.slice(1).some((arg) => {
      if (arg.startsWith('-')) return false;
      try { const target = realpathSync(path.resolve(cwd || root, arg)); return servers.some((server) => same(target, server)); } catch { return false; }
    });
  } catch { return false; }
}

/** Whether what listens on this port is this checkout's server and nothing else. */
export function ownsPort(root, port) {
  const pids = listeners(port);
  return pids.length > 0 && pids.every((pid) => {
    try {
      const { command, cwd } = describe(pid);
      return Boolean(cwd || process.platform === 'win32') && matchesServer(command, cwd, root);
    } catch { return false; }
  });
}

export async function stopServer(root, port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
  const pids = listeners(port);
  for (const pid of pids) {
    let info;
    try { info = describe(pid); } catch { continue; } // exited meanwhile
    if ((!info.cwd && process.platform !== 'win32') || !matchesServer(info.command, info.cwd, root)) {
      throw new Error('Port belongs to another program; it was not stopped.');
    }
  }
  for (const pid of pids) {
    // Windows has no SIGTERM; end the tree so agent CLIs the server started go too.
    if (process.platform === 'win32') { try { await killTree(Number(pid)); } catch { /* already gone */ } continue; }
    try { process.kill(Number(pid), 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  // Include a quiet period to detect a service manager immediately restarting it.
  let quiet = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 250));
    quiet = listeners(port).length ? 0 : quiet + 1;
    if (quiet >= 4) return;
  }
  throw new Error('Server is still running or was restarted by a service. Disable that service, then retry.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stopServer(process.argv[2], Number(process.argv[3])).catch((e) => {
    console.error(e.message); process.exitCode = 1;
  });
}
