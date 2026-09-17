/*
 * integrations/oauth.js — Helpers de autorización OAuth para la app de escritorio.
 *
 * Dos modos:
 *  1) authorizeLoopback: servidor local en 127.0.0.1 + NAVEGADOR DEL SISTEMA.
 *     Para Google/YouTube (Google bloquea navegadores embebidos) y TikTok (Login Kit Desktop).
 *  2) authorizeEmbedded: ventana de Electron que CAPTURA la redirección a una URL https
 *     registrada (ej. la página de Render o login_success.html de Facebook).
 *     Para Meta: Facebook, Instagram y Threads (exigen redirect https registrado).
 *
 * PKCE: Google usa base64url (RFC 7636); TikTok usa HEX(SHA256(verifier)).
 */
const http = require('http');
const crypto = require('crypto');
const { BrowserWindow, shell } = require('electron');

const PKCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function randomVerifier(len = 64) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PKCE_CHARS[bytes[i] % PKCE_CHARS.length];
  return out;
}

// encoding: 'base64url' (Google / estándar) o 'hex' (TikTok)
function pkcePair(encoding = 'base64url') {
  const verifier = randomVerifier(64);
  const challenge = crypto.createHash('sha256').update(verifier).digest(encoding === 'hex' ? 'hex' : 'base64url');
  return { verifier, challenge };
}

function randomState() {
  return crypto.randomBytes(16).toString('hex');
}

function resultPage(ok, message) {
  const title = ok ? '✅ Cuenta conectada' : '⚠️ No se completó la conexión';
  return '<!doctype html><meta charset="utf-8"><title>Calendario WoodTools</title>' +
    '<body style="font-family:Segoe UI,system-ui,sans-serif;background:#14161c;color:#e7e9ee;text-align:center;padding:64px 16px">' +
    `<h2>${title}</h2><p style="color:#a9afbd">${message}</p></body>`;
}

/*
 * opts: {
 *   authBaseUrl, clientId, clientParam='client_id', scope, extraAuthParams={},
 *   pkce=false, pkceEncoding='base64url', fixedPort=0, redirectPath='/',
 *   useSystemBrowser=true, timeoutMs=5min
 * }
 * Devuelve { code, redirectUri, codeVerifier, grantedScopes }
 */
function authorizeLoopback({
  authBaseUrl, clientId, clientParam = 'client_id', scope, extraAuthParams = {},
  pkce = false, pkceEncoding = 'base64url', fixedPort = 0, redirectPath = '/',
  useSystemBrowser = true, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let win = null;
    let timer = null;
    const state = randomState();
    const pk = pkce ? pkcePair(pkceEncoding) : null;
    const cbPath = redirectPath.startsWith('/') ? redirectPath : '/' + redirectPath;
    let redirectUri = '';

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => {
        try { server.close(); } catch (_) {}
        try { if (win && !win.isDestroyed()) win.close(); } catch (_) {}
      }, 600);
      if (err) reject(err); else resolve(value);
    };

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      // Ignorar cualquier otra ruta o pedido (ej. /favicon.ico)
      if (u.pathname !== cbPath || (!code && !error)) {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (settled) { res.end(resultPage(false, 'Esta autorización ya se procesó. Podés cerrar esta pestaña.')); return; }
      if (u.searchParams.get('state') !== state) {
        res.end(resultPage(false, 'La respuesta no coincide con el pedido. Volvé a tocar "Conectar" en la app.'));
        finish(new Error('La respuesta de autorización no coincide (state). Volvé a intentar.'));
        return;
      }
      if (error) {
        res.end(resultPage(false, 'Cerrá esta pestaña y volvé a intentar desde el Calendario WoodTools.'));
        finish(new Error(u.searchParams.get('error_description') || error));
        return;
      }
      res.end(resultPage(true, 'Ya podés cerrar esta pestaña y volver al Calendario WoodTools.'));
      // URLSearchParams ya decodificó el code; una segunda decodificación con un '%' suelto lanzaba
      // URIError dentro del servidor (error sin capturar en el proceso principal): se usa el valor tal cual
      let finalCode = code;
      try { finalCode = decodeURIComponent(code); } catch (_) { finalCode = code; }
      finish(null, {
        code: finalCode,
        redirectUri,
        codeVerifier: pk ? pk.verifier : null,
        grantedScopes: u.searchParams.get('scopes') || u.searchParams.get('scope') || null,
      });
    });

    server.on('error', (e) => {
      const msg = e && e.code === 'EADDRINUSE'
        ? `El puerto ${fixedPort} está ocupado por otro programa. Cerralo y volvé a intentar.`
        : 'No se pudo abrir el receptor local de autorización: ' + (e && e.message);
      finish(new Error(msg));
    });

    server.listen(fixedPort, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = `http://127.0.0.1:${port}${cbPath}`;
      const authUrl = new URL(authBaseUrl);
      authUrl.searchParams.set(clientParam, clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('state', state);
      if (pk) {
        authUrl.searchParams.set('code_challenge', pk.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
      }
      for (const [k, v] of Object.entries(extraAuthParams)) authUrl.searchParams.set(k, v);

      timer = setTimeout(() => finish(new Error('Se agotó el tiempo para autorizar (5 minutos). Volvé a intentar.')), timeoutMs);

      if (useSystemBrowser) {
        shell.openExternal(authUrl.toString()).catch((e) => finish(new Error('No se pudo abrir el navegador: ' + e.message)));
      } else {
        win = new BrowserWindow({
          width: 560, height: 720, autoHideMenuBar: true, title: 'Conectar cuenta',
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        });
        win.loadURL(authUrl.toString());
        win.on('closed', () => finish(new Error('Cerraste la ventana antes de autorizar.')));
      }
    });
  });
}

/*
 * Ventana embebida que captura la redirección a `redirectUri` (https registrado).
 * opts: { authUrl, redirectUri, state, partition, title, timeoutMs }
 * Devuelve { url, params } — params combina query y fragmento (#access_token=... de Facebook).
 * Limpia el sufijo "#_" que agregan Instagram/Threads al code.
 */
function authorizeEmbedded({
  authUrl, redirectUri, state = null, partition = 'persist:calendario-oauth',
  title = 'Conectar cuenta', timeoutMs = 10 * 60 * 1000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const target = new URL(redirectUri);
    const norm = (p) => p.replace(/\/+$/, '');

    const win = new BrowserWindow({
      width: 600, height: 760, autoHideMenuBar: true, title,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    const matches = (url) => {
      try {
        const u = new URL(url);
        return u.origin === target.origin && norm(u.pathname) === norm(target.pathname);
      } catch (_) { return false; }
    };

    const parse = (url) => {
      const u = new URL(url);
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      const hash = u.hash.replace(/^#_?/, '');
      if (hash) new URLSearchParams(hash).forEach((v, k) => { if (!(k in params)) params[k] = v; });
      if (params.code) params.code = params.code.replace(/#_$/, '');
      return params;
    };

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setImmediate(() => { try { if (!win.isDestroyed()) win.close(); } catch (_) {} });
      if (err) reject(err); else resolve(value);
    };

    // Electron nuevo pasa (details) con details.url; el viejo pasa (event, url)
    const urlOf = (e, u) => (typeof u === 'string' ? u : (e && e.url) || '');

    const handle = (e, rawUrl, cancelable) => {
      const url = urlOf(e, rawUrl);
      if (settled || !url || !matches(url)) return false;
      if (cancelable && e && typeof e.preventDefault === 'function') e.preventDefault();
      const params = parse(url);
      if (params.error || params.error_reason || params.error_code) {
        done(new Error(params.error_description || params.error_message || params.error_reason || params.error || 'Autorización cancelada.'));
        return true;
      }
      if (state && params.state !== state) {
        done(new Error('La respuesta de autorización no coincide (state). Volvé a intentar.'));
        return true;
      }
      done(null, { url, params });
      return true;
    };

    const wc = win.webContents;
    wc.on('will-redirect', (e, url) => handle(e, url, true));
    wc.on('will-navigate', (e, url) => handle(e, url, true));
    wc.on('did-redirect-navigation', (e, url) => handle(e, url, false));
    wc.on('did-navigate', (e, url) => handle(e, url, false));
    wc.on('did-navigate-in-page', (e, url) => handle(e, url, false));
    wc.setWindowOpenHandler(({ url }) => {
      if (handle(null, url, false)) return { action: 'deny' };
      // Popups del login (ej. "¿Olvidaste tu contraseña?"): misma sesión aislada y sin permisos extra
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win, autoHideMenuBar: true,
          webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    });

    win.on('closed', () => done(new Error('Cerraste la ventana antes de autorizar.')));
    timer = setTimeout(() => done(new Error('Se agotó el tiempo para autorizar. Volvé a intentar.')), timeoutMs);
    win.loadURL(authUrl);
  });
}

module.exports = { authorizeLoopback, authorizeEmbedded, pkcePair, randomState };
