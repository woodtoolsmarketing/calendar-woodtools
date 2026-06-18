/*
 * integrations/oauth.js — OAuth con redirect a loopback (127.0.0.1).
 * Abre una ventana con la pantalla de consentimiento y captura el "code".
 * Sirve para YouTube (Google) y TikTok. Devuelve { code, redirectUri }.
 */
const http = require('http');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');

function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// opts: { authBaseUrl, clientId, clientParam='client_id', scope, extraAuthParams, pkce=false, fixedPort=0, redirectPath='' }
function authorizeLoopback({ authBaseUrl, clientId, clientParam = 'client_id', scope, extraAuthParams = {}, pkce = false, fixedPort = 0, redirectPath = '' }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let win = null;
    const pk = pkce ? pkcePair() : null;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,system-ui,sans-serif;background:#14161c;color:#e7e9ee;text-align:center;padding-top:64px"><h2>✅ Cuenta conectada</h2><p>Ya podés cerrar esta ventana y volver al Calendario WoodTools.</p></body>');
      if (settled) return;
      settled = true;
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} server.close(); }, 400);
      if (code) resolve({ code, redirectUri: `http://127.0.0.1:${server.address().port}${redirectPath}`, codeVerifier: pk ? pk.verifier : null });
      else reject(new Error(error || 'No se recibió el código de autorización.'));
    });

    server.on('error', (e) => { if (!settled) { settled = true; reject(e); } });

    server.listen(fixedPort, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}${redirectPath}`;
      const authUrl = new URL(authBaseUrl);
      authUrl.searchParams.set(clientParam, clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
      authUrl.searchParams.set('state', crypto.randomBytes(8).toString('hex'));
      if (pk) {
        authUrl.searchParams.set('code_challenge', pk.challenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
      }
      for (const [k, v] of Object.entries(extraAuthParams)) authUrl.searchParams.set(k, v);

      win = new BrowserWindow({
        width: 560, height: 720, autoHideMenuBar: true, title: 'Conectar cuenta',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      win.loadURL(authUrl.toString());
      win.on('closed', () => {
        if (!settled) { settled = true; try { server.close(); } catch (_) {} reject(new Error('Cerraste la ventana antes de autorizar.')); }
      });
    });
  });
}

module.exports = { authorizeLoopback };
