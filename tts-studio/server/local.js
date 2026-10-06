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

export function localOnly() {
  return (req, res, next) => {
    const host = hostname(String(req.headers.host || ''));
    const origin = req.headers.origin;
    if (!isLocal(host)) return res.status(403).json({ error: 'This server only answers on localhost.' });
    if (origin && origin !== 'null' && !isLocal(hostname(String(origin)))) {
      return res.status(403).json({ error: 'Requests from other sites are not accepted.' });
    }
    if (origin === 'null' && !['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'Requests from other sites are not accepted.' });
    }
    next();
  };
}
