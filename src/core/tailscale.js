import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loginPath } from './tools.js';

// Standard installations are the default. Custom daemons are an explicit option,
// never a hidden dependency on one developer's machine.
export async function tailscaleCommand(env = process.env, platform = process.platform, execute = promisify(execFile)) {
  const binary = env.ORCHESTRATOR_TAILSCALE_BIN;
  const socket = env.ORCHESTRATOR_TAILSCALE_SOCKET;
  if (binary || socket !== undefined) return [binary || 'tailscale', ...(socket ? ['--socket', socket] : [])];
  const candidates = platform === 'darwin'
    ? [['/Applications/Tailscale.app/Contents/MacOS/Tailscale'], ['tailscale']]
    : platform === 'win32' ? [['tailscale.exe'], [(env.ProgramFiles || 'C:\\Program Files') + '\\Tailscale\\tailscale.exe']] : [['tailscale']];
  let available;
  for (const command of candidates) {
    try {
      const result = await execute(command[0], [...command.slice(1), 'status', '--json'], { timeout: 4000, env });
      const state = JSON.parse(result.stdout);
      available ??= command;
      if (state.BackendState === 'Running') return command;
    } catch { /* Try the next installed client. */ }
  }
  return available || candidates[0];
}

export async function tailscale(args, timeout = 4000) {
  const env = { ...process.env, PATH: await loginPath() };
  const [command, ...prefix] = await tailscaleCommand(env);
  return promisify(execFile)(command, [...prefix, ...args], { timeout, env });
}

export function phoneRoute(config, port) {
  for (const [host, site] of Object.entries(config.Web || {})) {
    const proxy = site.Handlers?.['/']?.Proxy?.replace(/\/$/, '');
    const httpsPort = host.split(':').at(-1);
    if (config.TCP?.[httpsPort]?.HTTPS && !config.AllowFunnel?.[host] &&
        [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(proxy)) {
      return `https://${host.replace(/:443$/, '')}/`;
    }
  }
  return '';
}

export async function networkStatus(port, run = tailscale) {
  const result = { localUrl: `http://127.0.0.1:${port}`, phoneUrl: '', connected: false, ready: false };
  try {
    const state = JSON.parse((await run(['status', '--json'])).stdout);
    result.connected = state.BackendState === 'Running' && state.Self?.Online !== false;
    if (!result.connected) return { ...result, message: 'Open Tailscale on this host and sign in or connect. Then check again.' };
  } catch {
    return { ...result, message: 'Tailscale unavailable. Install and open Tailscale on this host, then check again. Custom installations can set ORCHESTRATOR_TAILSCALE_BIN and ORCHESTRATOR_TAILSCALE_SOCKET.' };
  }
  try {
    const config = JSON.parse((await run(['serve', 'status', '--json'])).stdout || '{}');
    result.phoneUrl = phoneRoute(config, port);
    result.ready = Boolean(result.phoneUrl);
    return { ...result, message: result.ready ? 'Private HTTPS route configured; phone reachability unverified.' : 'Tailscale connected. Set up phone access to publish this server.' };
  } catch {
    return { ...result, message: 'Tailscale connected, but Serve status could not be read. Update Tailscale or check this user’s permission to manage Serve.' };
  }
}

let setupPending;
export function setupPhoneAccess(port) {
  // Share one operation across double taps, tabs and callers.
  if (!setupPending) setupPending = configurePhoneAccess(port).finally(() => { setupPending = null; });
  return setupPending;
}

export async function configurePhoneAccess(port, run = tailscale) {
  const status = await networkStatus(port, run);
  if (status.ready || !status.connected) return status;
  try {
    // Recheck just before mutation. Never reset Serve or replace another service.
    const config = JSON.parse((await run(['serve', 'status', '--json'])).stdout || '{}');
    const used = new Set([...Object.keys(config.TCP || {}), ...Object.keys(config.Web || {}).map((host) => host.split(':').at(-1))]);
    const available = [443, ...Array.from({ length: 100 }, (_, i) => 8443 + i)].find((p) => !used.has(String(p)));
    if (!available) return { ...status, message: 'No unused HTTPS port available. Free a Serve port in Tailscale and retry.' };
    await run(['serve', '--bg', `--https=${available}`, `http://127.0.0.1:${port}`], 15000);
    return await networkStatus(port, run);
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    const approvalUrl = output.match(/https:\/\/(?:login|console)\.tailscale\.com\/[^\s<>"']+/)?.[0];
    return { ...status, approvalUrl,
      message: approvalUrl ? 'Tailscale needs account approval for HTTPS. Open the approval link, then retry setup.' : 'Could not publish HTTPS. Check Tailscale permissions and HTTPS settings on this host, then retry. No existing routes were replaced.' };
  }
}
