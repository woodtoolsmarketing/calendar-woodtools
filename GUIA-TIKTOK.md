# Guía: conectar TikTok

Necesitás un **Client Key** y **Client Secret** de una app en el portal de
desarrolladores de TikTok. Sin auditar, el video se sube a tus **borradores** de TikTok
y vos lo publicás desde la app (2 toques). El posteo público directo requiere auditoría.

---

## PASO 1 — Crear la app
1. Entrá a **https://developers.tiktok.com/** e iniciá sesión (con tu cuenta de creador).
2. **Manage apps** → **Connect an app** / **Create an app**.
3. Completá nombre (*Calendario WoodTools*), categoría, etc.

## PASO 2 — Agregar productos
4. Dentro de la app → **Add products**:
   - **Login Kit** (para el inicio de sesión / OAuth).
   - **Content Posting API** (para subir videos).

## PASO 3 — Configurar el redirect (¡importante!)
5. En **Login Kit** → configuración de la plataforma, agregá un **Redirect URI** para
   **escritorio**. TikTok permite `127.0.0.1` con **puerto comodín**. Poné exactamente:
   ```
   http://127.0.0.1:*/
   ```
   (Si el campo no acepta el `*`, probá `http://127.0.0.1` y elegí la opción de "desktop".)

## PASO 4 — Permisos (scopes)
6. Activá / solicitá los permisos: **`user.info.basic`** y **`video.upload`**.
   (`video.publish`, para postear público directo, lo agregás cuando la app esté auditada.)

## PASO 5 — Copiar las credenciales
7. En la pantalla de la app vas a ver **Client Key** y **Client Secret** → **copiá los dos**.

## PASO 6 — Conectar en la app
8. Calendario WoodTools → **⚙ Conexiones → 🎵 TikTok** → pegá **Client Key** y **Client Secret**.
9. Clic en **"🎵 Conectar con TikTok"** → se abre el login de TikTok → iniciá sesión y **autorizá**.
10. Si dice **"✅ TikTok conectado"**, listo.

---

## Cómo publicar
- Tarea **Contenido → TikTok → Video** → **📎 Elegir archivo** (MP4) → **Publicar automático** o **📤 Publicar ahora**.
- El video aparece en los **borradores de TikTok** → abrís TikTok y tocás **Publicar** (le ponés sonido, hashtags, etc.).
- Cuando tu app esté **auditada**, tildás **"Posteo directo"** en Conexiones y publica solo.

## Si falla al conectar
- **"redirect_uri mismatch":** el redirect del Paso 3 no coincide. Mandame el error y te paso el formato exacto.
- **"scope not authorized":** falta activar `video.upload` en los productos/permisos de la app.
