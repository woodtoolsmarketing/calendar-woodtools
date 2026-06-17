/*
 * integrations/oauth.js — OAuth con redirect a loopback (127.0.0.1).
 * Abre una ventana con la pantalla de consentimiento y captura el "code".
 * Sirve para YouTube (Google) y TikTok. Devuelve { code, redirectUri }.
 */
const http = require('http');
const { BrowserWindow } = require('electron');

function authorizeLoopback({ authBaseUrl, clientId, scope, extraAuthParams = {} }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let win = null;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,system-ui,sans-serif;background:#14161c;color:#e7e9ee;text-align:center;padding-top:64px"><h2>✅ Cuenta conectada</h2><p>Ya podés cerrar esta ventana y volver al Calendario WoodTools.</p></body>');
      if (settled) return;
      settled = true;
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.close(); } catch (_) {} server.close(); }, 400);
      if (code) resolve({ code, redirectUri: `http://127.0.0.1:${server.address().port}` });
      else reject(new Error(error || 'No se recibió el código de autorización.'));
    });

    server.on('error', (e) => { if (!settled) { settled = true; reject(e); } });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = new URL(authBaseUrl);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', scope);
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
