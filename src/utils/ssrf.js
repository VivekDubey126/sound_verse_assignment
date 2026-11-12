const { URL } = require('url');
const net = require('net');

const BLOCKED_RANGES = [
  { start: '127.0.0.0', end: '127.255.255.255' },
  { start: '169.254.0.0', end: '169.254.255.255' },
  { start: '10.0.0.0', end: '10.255.255.255' },
  { start: '172.16.0.0', end: '172.31.255.255' },
  { start: '192.168.0.0', end: '192.168.255.255' },
];

function ipToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip) {
  if (!net.isIPv4(ip)) return true;
  const ipLong = ipToLong(ip);
  for (const range of BLOCKED_RANGES) {
    if (ipLong >= ipToLong(range.start) && ipLong <= ipToLong(range.end)) return true;
  }
  return false;
}

function validateWebhookUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return 'Invalid URL format';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'URL must use HTTP or HTTPS protocol';
  }

  const hostname = parsed.hostname;
  if (net.isIPv4(hostname) && isPrivateIp(hostname)) {
    return 'Webhook URL must not target a private or reserved IP address';
  }

  const blockedHostnames = ['localhost', '0.0.0.0', '169.254.169.254'];
  if (blockedHostnames.includes(hostname.toLowerCase())) {
    return 'Webhook URL must not target internal or metadata infrastructure';
  }

  return null;
}

module.exports = { validateWebhookUrl };

