import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function defaultDataDir(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'DistributedOrchestrator');
  return path.join(home, 'Library', 'Application Support', 'harness');
}
export function shellCommand(command, platform = process.platform, env = process.env) {
  return platform === 'win32' ? [env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/sh', ['-lc', command]];
}
export async function windowsListeners(execute = promisify(execFile)) {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object @{n="pid";e={$_.OwningProcess}},@{n="port";e={$_.LocalPort}}) | ConvertTo-Json -Compress'], { timeout: 10000, windowsHide: true });
  return (JSON.parse(stdout.trim() || '[]')).map((p) => ({ ...p, cwd: null }));
}
export async function killTree(pid) {
  if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else process.kill(pid, 'SIGTERM');
}
