import { isIP } from 'node:net';

const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const tailnet = address => {
  if (!isIP(address)) return false;
  if (address.startsWith('fd7a:115c:a1e0:')) return true;
  const [first, second] = address.split('.').map(Number);
  return first === 100 && second >= 64 && second <= 127;
};

export function viewerAddress(req) {
  let address = req.socket.remoteAddress || '';
  if (loopback(address)) {
    // Only the local, authenticated Serve proxy supplies a remote identity.
    if (!req.headers['tailscale-user-login'] || req.headers['tailscale-funnel-request']) return '';
    address = String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim();
  }
  address = address.replace(/^::ffff:/, '').toLowerCase();
  return tailnet(address) ? address : '';
}
