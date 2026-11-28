import * as net from 'net';

/** 127.0.0.0/8, ::1 and "localhost". A host NAME is never trusted to be loopback (except localhost). */
export function isLoopbackHost(host: string): boolean {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (h.toLowerCase() === 'localhost') return true;
  const family = net.isIP(h);
  if (family === 4) return h.split('.')[0] === '127';
  if (family === 6) {
    const lower = h.toLowerCase();
    return lower === '::1' || /^(0{0,4}:){1,6}0{0,3}1$/.test(lower) || lower.startsWith('::ffff:127.');
  }
  return false;
}
