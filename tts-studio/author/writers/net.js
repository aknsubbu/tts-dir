import dns from 'node:dns/promises';
import net from 'node:net';
import { ProviderError } from './common.js';

/**
 * Where a provider may be reached. A provider's address is typed by a person, and with profiles that person may
 * not be the one who runs this computer, so the server must not be made to ask a cloud machine for its own
 * credentials (169.254.169.254 and its IPv6 and named twins) or to follow an answer that sends it there.
 * Loopback and private networks stay allowed: that is where a model on this Mac, or on another machine at home, is.
 */
const METADATA_NAMES = new Set(['metadata.google.internal', 'metadata', 'instance-data']);

const clean = (host) => String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

/** True for link-local and cloud-metadata addresses, however the IP is written (IPv4-mapped IPv6 included). */
export function isMetadataAddress(address) {
  let ip = clean(address);
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip) || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (mapped) {
    ip = mapped[2] ? `${parseInt(mapped[1], 16) >> 8}.${parseInt(mapped[1], 16) & 255}.${parseInt(mapped[2], 16) >> 8}.${parseInt(mapped[2], 16) & 255}` : mapped[1];
  }
  if (net.isIPv4(ip)) return ip.startsWith('169.254.');
  if (net.isIPv6(ip)) {
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || /^fd00:0?ec2:/.test(ip); // fe80::/10 and AWS's fd00:ec2::/32
  }
  return false;
}

export const isMetadataName = (host) => METADATA_NAMES.has(clean(host));

/** Throws unless every address `host` points at is fine to call. `lookup` can be replaced in tests. */
export async function checkHost(host, { lookup = (h) => dns.lookup(h, { all: true }) } = {}) {
  const name = clean(host);
  if (isMetadataName(name) || isMetadataAddress(name)) throw new ProviderError('That address is not one a provider can be reached at.', 'unreachable');
  if (net.isIP(name)) return;
  let found;
  try {
    found = await lookup(name);
  } catch {
    return; // it does not resolve: the request will say so
  }
  if (found.some((a) => isMetadataAddress(a.address))) throw new ProviderError('That address is not one a provider can be reached at.', 'unreachable');
}

/** fetch for provider requests: checks where the name leads, and refuses to be sent on somewhere else. */
export async function guardedFetch(input, init = {}, options = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  await checkHost(url.hostname, options);
  const res = await fetch(input, { ...init, redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) throw new ProviderError(`${url.hostname} answered with a redirect, which a provider address is not allowed to follow.`, 'unreachable');
  return res;
}
