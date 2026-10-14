/**
 * Both servers listen on 127.0.0.1, so only this machine can connect. A web page open in
 * a browser on this machine is on this machine too, though, and these two checks are what
 * keep other sites' pages out:
 *
 *   Host     must be localhost or a loopback address. A page that points its own domain
 *            at 127.0.0.1 (DNS rebinding) still sends its own name here.
 *   Origin   when the browser sends one, must be local as well, so another site cannot
 *            post a lesson or delete from the library.
 *
 * Requests from curl and from the dashboard's own server send no Origin and pass.
 *
 * With TTS_LAN=1 the server listens on every interface and these checks also accept this
 * machine's own private-network names (192.168.x.x, 10.x.x.x, 172.16-31.x.x, 169.254.x.x, a bare
 * name or .local), and an Origin only when it is the page's own address. A public name in Host
 * is still refused, so a rebinding page cannot reach it. There is no login: use it on a network
 * you trust.
 */
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostname(value) {
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const isLocal = (name) => LOCAL.has(name) || name.endsWith('.localhost');

/** A name on a private network: an address in a private range, a bare name, or a .local name. */
export function isPrivateNetwork(name) {
  const ip = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return name.endsWith('.local') || /^[a-z0-9-]+$/.test(name);
}

/** `lan` says whether private-network names answer too; a function, so it is read on every request. */
export function localOnly({ lan = () => false } = {}) {
  return (req, res, next) => {
    const host = hostname(String(req.headers.host || ''));
    const origin = req.headers.origin;
    const viaLan = !isLocal(host) && lan() && isPrivateNetwork(host);
    if (!isLocal(host) && !viaLan) return res.status(403).json({ error: 'This server only answers on localhost.' });
    if (origin && origin !== 'null') {
      const from = hostname(String(origin));
      if (!isLocal(from) && !(viaLan && from === host)) {
        return res.status(403).json({ error: 'Requests from other sites are not accepted.' });
      }
    }
    if (origin === 'null' && !['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'Requests from other sites are not accepted.' });
    }
    next();
  };
}
