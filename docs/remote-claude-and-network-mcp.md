# Plan: MCP over the network, and your own computer's Claude as the lesson writer

Status: **planned, not started.** Written after profiles shipped (see [Sharing with housemates](../README.md#sharing-with-housemates)).

## Goals

1. **MCP over the network.** Each person's Claude (Claude Code or the desktop app, on their own computer) connects to the dashboard over the network and acts as their profile.
2. **A Claude server you can run on a laptop.** A small Express service, started with one command, that runs the `claude` command where Claude is signed in, and can be reached over the network.
3. **Your laptop's Claude as the lesson writer.** Sign in to your profile, add your Claude server's URL (and its token), and the dashboard sends the lesson-writing requests there, so a lesson is written by the Claude on your laptop even though the dashboard runs somewhere else.

## What is true today

**MCP.** `/mcp` is mounted on the same Express app as the dashboard. With `TTS_LAN=1` it already answers on private network addresses, and a connector token makes Claude act as one profile. Five things stop that being fit for the network:

| # | Gap | Where |
| --- | --- | --- |
| 1 | The Host check accepts private ranges and `.local` names only. Tailscale (`100.64.0.0/10`, `*.ts.net`) and any other name is refused. | `server/local.js` |
| 2 | Links in tool answers, and the commands under Settings → Connect Claude, use `localhost`. | `mcp/http.js` (`linkBase`), `server/settings-routes.js` (`/connect`) |
| 3 | **Security.** Over HTTP, `make_lesson` and `revise_lesson` read their `files` paths from the **server's** disk. On a network, a token holder could read other profiles' lesson notes or any non-private image, PDF or text file on the host. Harmless on localhost, so it was never a problem until now. | `mcp/http.js`, `mcp/files.js` |
| 4 | `get_video` returns a path on the host, and the token allowlist has no video or captions download, so a remote client cannot fetch the result. | `mcp/server.js`, `server/profile-routes.js` (`CONNECTOR_ROUTES`) |
| 5 | No TLS. Tokens, PINs and notes cross the network in clear. | everywhere |

**The Claude command.** The writer shells out to `claude -p` on the host (`author/claude.js`, `askClaude`). It runs with `--tools ''`, `--safe-mode` and no session, from an empty temp folder; pictures and PDFs go in the message as base64; the answer comes back as JSON with a cost. That is a thin, well-bounded call, so it can move to another machine without changing what Claude is able to do.

The stdio connector (`mcp/stdio.js`) already works against a remote dashboard: it runs on the laptop, reads the laptop's files, uploads them, and takes `NARRATED_PROOFS_URL` and `NARRATED_PROOFS_TOKEN`.

## Phase A: dashboard and MCP over the network (do first; includes a security fix)

- [ ] **`TTS_ALLOWED_HOSTS`**: extra host names and CIDRs the Host check accepts (documented with Tailscale values). Used by the dashboard and by the Claude server (Phase B). Origin handling stays as it is.
- [ ] **Links from the request.** Build `linkBase` from the request's `Host` header; never trust `X-Forwarded-*`. Settings → Connect Claude lists the addresses the page is reachable on (the one in the address bar, and this computer's private addresses).
- [ ] **Fix file reads over HTTP (gap 3).** The HTTP handler stops reading paths: `files` returns a clear message pointing to the stdio connector. The stdio connector runs on the laptop, reads the laptop's files and uploads them. Settings shows that as the primary remote command.
- [ ] **Video delivery (gap 4).** Add read-only `GET /generations/:id/video` and `captions.:ext` (own lessons only) to the token allowlist. The stdio `get_video` downloads the MP4 and captions to a folder on the laptop and returns that path; the HTTP version returns a dashboard link and says it needs the profile's sign-in.
- [ ] **Tests.** A token over HTTP cannot read a host path; the allowlist test (which fails on any route added without being classified) covers the new routes; links use the request host; a Tailscale-style host is accepted only when listed.

## Phase B: the Claude server (runs where `claude` is signed in)

A new service, `npm run claude-server` in `tts-studio/`.

- **Start.** Binds to `127.0.0.1` by default; `--lan` (or `CLAUDE_SERVER_HOST=0.0.0.0`) serves it on the network. The first start makes a long random token, keeps it in a file only the user can read, and prints it once, with the URL to paste into the dashboard.
- **Endpoints.**
  - `GET /health`: version, whether the `claude` command was found.
  - `POST /jobs`: `{ system, prompt, schema, attachments: [{ name, kind, type, dataBase64 }], model, effort }`, answers `202 { id }`.
  - `GET /jobs/:id`: `{ status, answer, costUsd, usage }` when done; polled with back-off.
  - `DELETE /jobs/:id`: cancels and kills the process.
  - A job pattern, not one long request, because a lesson can take 20 minutes and a request that long does not survive proxies, sleep or restarts, or let you cancel.
- **Reuse `askClaude` itself**, so the flags never drift. Tools stay off on the server side. `model` and `effort` are checked against fixed patterns; the schema must be a JSON object under a size limit; nothing else from the request reaches the command line.
- **Protection.** Constant-time token check; Host check (shares `TTS_ALLOWED_HOSTS`); optional `CLAUDE_SERVER_ALLOW_FROM` source-address list; body size limit; at most 2 jobs at once; prompts never logged; optional `CLAUDE_SERVER_MAX_USD_PER_DAY` so a leaked token cannot run up your subscription.
- **Tests** with a fake `claude` binary (the same style as the existing lesson tests): auth, cancel, size limits, concurrency, daily cap.

## Phase C: "Claude on another computer" as a writer, per profile

- [ ] New provider kind (working name `claude-remote`) in `shared/providers.js`: an editable address and a token, the same capabilities as Claude Code (pictures, PDFs, effort, large context), cost taken from what the server reports.
- [ ] **Settings → Lesson writer card**: the server URL, the token (stored as a per-profile secret, never shown again), and a **Test** that checks `/health` and runs one tiny job. "Where your notes go" names the laptop.
- [ ] **Adapter** `author/writers/claude-remote.js`: builds the job from the pipeline's `ask` call (reads attachments from disk, sends base64), polls, cancels on abort, and turns failures into plain words ("your computer is not reachable at …", "the token was refused", "Claude is not signed in there").
- [ ] **Not the host's Claude.** It is the profile's own, so the Owner's "may use this Mac's Claude sign-in" switch and the host-spend limit do not apply, and a housemate can use their own laptop. It is not marked host-paid; the profile's own caps and cost counting still apply.
- [ ] **SSRF.** Goes through the existing guarded fetch: metadata addresses refused, the address checked at connect time, redirects not followed. Private and LAN addresses are allowed, because that is the point.
- [ ] **Tests.** Adapter against a real Claude server with the fake `claude`; isolation (one profile's token never used for another); cancel; unreachable; wrong token; the Test button; per-profile settings and deleting a profile removes the token.

## Phase D: hardening and docs

- [ ] **TLS** (optional): `TTS_TLS_CERT` / `TTS_TLS_KEY` for the dashboard and the same for the Claude server. Recommend Tailscale (encrypted, with real certificates via MagicDNS) or a reverse proxy.
- [ ] **Warn** in the UI when a token is about to be sent over plain `http://` to an address that is not on a private or Tailscale range.
- [ ] **Docs**: README section "Use your laptop's Claude" (start the server, copy the URL and token, add it under Settings → Lesson writer), the network MCP commands, and an update to [Known limits](../README.md#known-limits).

## Open questions

1. **Direction.** The plan has the dashboard call the laptop. That fails when the laptop sleeps, changes network or sits behind NAT or a firewall. A fallback would have the laptop connect out to the dashboard and pick up jobs (a job queue per profile, authenticated with a connector token). It is a good deal more work; add it only if the simple version is not enough.
2. **Network.** Same home network, or Tailscale or another VPN? That decides whether TLS belongs in Phase A or D.
3. **Packaging the Claude server.** `npm run claude-server` from a clone of this repository (needs Node and a signed-in `claude`), or a standalone download?
4. **Files over HTTP MCP.** Is "stdio connector on the laptop for notes and files, HTTP for the rest" acceptable, or should the HTTP tools accept file contents uploaded in the call?

## Still to fix or finish from the profiles work

These are known limits, not unbuilt parts of the profiles feature (they are also listed under [Known limits](../README.md#known-limits)):

- [ ] **Unconfined scenes outside macOS.** On Linux and in Docker, lessons the writer makes from anyone's notes run as the server does. A render container or bubblewrap would fix it.
- [ ] **A combined cap on host spending across all profiles.** Limits are per profile today.
- [ ] **Fair scheduling between profiles.** One render at a time for everyone.
- [ ] **A stolen connector token** can still start lessons and change allowed settings at that profile's expense until revoked. Options: shorter idle expiry, per-token spend cap, notifying the profile when a token is first used from a new address.
- [ ] **The desktop extension is untested in the real app.** Install `npm run mcp:pack` output in the Claude desktop app and confirm the token field arrives as `NARRATED_PROOFS_TOKEN`.
- [ ] **A background review finding in `server/profile-routes.js`** was never specified; re-run a review there once the text can be recovered.
- [ ] **HTTPS for a LAN** (Phase D above) so PINs and tokens are not in clear.
