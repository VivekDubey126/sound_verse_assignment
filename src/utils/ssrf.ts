import { URL } from 'url';
import net from 'net';

// Private and reserved IP ranges that webhooks must not target
const BLOCKED_RANGES = [
  // Loopback
  { start: '127.0.0.0', end: '127.255.255.255' },
  // Link-local (AWS metadata endpoint lives here)
  { start: '169.254.0.0', end: '169.254.255.255' },
  // Private class A
  { start: '10.0.0.0', end: '10.255.255.255' },
  // Private class B
  { start: '172.16.0.0', end: '172.31.255.255' },
  // Private class C
  { start: '192.168.0.0', end: '192.168.255.255' },
  // Current network
  { start: '0.0.0.0', end: '0.255.255.255' },
  // IETF protocol assignments
  { start: '192.0.0.0', end: '192.0.0.255' },
  // Documentation (TEST-NET-1)
  { start: '192.0.2.0', end: '192.0.2.255' },
  // 6to4 relay anycast
  { start: '192.88.99.0', end: '192.88.99.255' },
  // Documentation (TEST-NET-2)
  { start: '198.51.100.0', end: '198.51.100.255' },
  // Documentation (TEST-NET-3)
  { start: '203.0.113.0', end: '203.0.113.255' },
  // Multicast
  { start: '224.0.0.0', end: '239.255.255.255' },
  // Reserved
  { start: '240.0.0.0', end: '255.255.255.255' },
];

function ipToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIp(ip: string): boolean {
  if (!net.isIPv4(ip)) return true; // Block IPv6 for simplicity (conservative)
  const ipLong = ipToLong(ip);
  for (const range of BLOCKED_RANGES) {
    const start = ipToLong(range.start);
    const end = ipToLong(range.end);
    if (ipLong >= start && ipLong <= end) return true;
  }
  return false;
}

/**
 * Validate that a webhook URL is safe (not targeting internal infrastructure).
 * Returns an error message if unsafe, null if safe.
 */
export function validateWebhookUrl(urlString: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return 'Invalid URL format';
  }

  // Must be HTTPS or HTTP
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'URL must use HTTP or HTTPS protocol';
  }

  // Block IP addresses in hostname directly
  const hostname = parsed.hostname;
  if (net.isIPv4(hostname)) {
    if (isPrivateIp(hostname)) {
      return 'Webhook URL must not target a private or reserved IP address';
    }
  }

  // Block common internal hostnames
  const blockedHostnames = [
    'localhost',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata.google',
    'kubernetes.default',
    'kubernetes.default.svc',
  ];
  if (blockedHostnames.includes(hostname.toLowerCase())) {
    return 'Webhook URL must not target internal infrastructure';
  }

  // Block cloud metadata IPs
  const metadataIps = ['169.254.169.254', '169.254.170.2', '100.100.100.200'];
  if (metadataIps.includes(hostname)) {
    return 'Webhook URL must not target cloud metadata endpoints';
  }

  return null;
}

