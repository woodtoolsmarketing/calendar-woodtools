# Guía: conectar TikTok

Necesitás un **Client Key** y un **Client Secret** de una app en el portal de desarrolladores de TikTok.

- **Sin auditoría:** el video llega a tus **borradores** de TikTok y lo terminás de publicar desde la
  app de TikTok.
- **Con la app aprobada y auditada:** la app publica sola, con la privacidad que elijas.

La revisión de TikTok (video de demostración, textos listos para pegar y auditoría) está en la
sección 6 de [GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md).

---

## PASO 1: crear la app

1. Entrá a https://developers.tiktok.com/ con la cuenta de TikTok de WoodTools.
2. **Manage apps → Connect an app**. Registrala a nombre de la **organización** (WoodTools), no como individuo.
3. Nombre **Calendario WoodTools** (sin mencionar TikTok), ícono `assets/icon-1024.png`, categoría y descripción.
4. **Terms of Service URL:** `https://calendario-woodtools.onrender.com/terms.html`
   **Privacy Policy URL:** `https://calendario-woodtools.onrender.com/privacy.html`
5. **Platforms → Desktop** → URL `https://calendario-woodtools.onrender.com/`.

## PASO 2: verificar el sitio (URL properties)

6. **URL properties → Verify properties** → **URL prefix** → `https://calendario-woodtools.onrender.com/`.
7. **Download** del archivo `tiktok….txt` → copialo en la carpeta `docs/` del proyecto → subilo al
   repositorio (Render lo publica) → **Verify**.

## PASO 3: productos

8. **Add products** → **Login Kit** y **Content Posting API**.
9. **Login Kit → Desktop → Redirect URI**, exactamente:
   ```
   http://127.0.0.1:8723/
   ```
   Tiene que estar en la plataforma **Desktop** (no en Web) y con la barra final. No uses `*`.
10. **Content Posting API → Direct Post:** activado.

## PASO 4: permisos (scopes)

11. `user.info.basic`, `video.upload` y `video.publish`.

## PASO 5: copiar las credenciales

12. **Client Key** y **Client Secret**. Ojo: *Sandbox* y *Production* tienen claves distintas. Usá las
    de Sandbox para probar y grabar la demo; las de Production cuando TikTok apruebe la app.

## PASO 6: conectar en la app

13. **⚙ Conexiones → TikTok** → pegá **Client Key** y **Client Secret**.
14. **Mi app de TikTok pasó la auditoría**: dejalo **destildado** hasta que TikTok apruebe la auditoría
    (modo borradores). Tocá **Guardar**.
15. Tocá **Conectar** → se abre **tu navegador** con TikTok → iniciá sesión → **Autorizar**.
16. El estado muestra el nombre de la cuenta.

**Cuando TikTok apruebe la auditoría:** tildá **Mi app de TikTok pasó la auditoría**, tocá **Guardar** y
**Conectar** otra vez (agrega el permiso de publicación directa).

**Una vez por año** TikTok pide volver a autorizar. La app avisa 30 días antes: tocá **Conectar**.
El acceso diario se renueva solo.

---

## Cómo publicar

1. Tarea de Tipo **Contenido de redes** → tildá **TikTok** → **Publicar automático** →
   **📎 Elegir archivo** (MP4 recomendado, o MOV).
2. En el bloque de TikTok (en modo borradores solo aparece el aviso de que va a tu bandeja):
   - **Publicando como:** la cuenta de TikTok donde se va a publicar.
   - **¿Quién puede ver este video?:** obligatorio y **sin valor por defecto** (las opciones las da tu cuenta).
   - **Permitir comentarios, Dúo y Stitch:** desmarcados por defecto; en gris si tu cuenta los tiene desactivados.
   - **Divulgar contenido comercial:** activalo si el video promociona algo → **Tu marca**
     (productos de WoodTools) y/o **Contenido de marca** (colaboración paga). Con Contenido de marca no
     se puede elegir *Solo yo*.
   - **Portada: segundo del video:** el momento del video que se usa como portada.
   - Al publicar aceptás la **Declaración de confirmación de uso de música** de TikTok (y la Política de
     contenido de marca, si corresponde). No hay casilla: el texto aparece en el bloque.
3. **Guardar** (se publica sola a la hora programada) o **📤 Publicar ahora**, que antes pide confirmar
   y muestra quién va a poder ver el video.

- **Modo borradores (sin auditar):** TikTok te manda una notificación; abrís el borrador en la app de
  TikTok y lo publicás. Máximo **5 borradores pendientes cada 24 h**. La app lo marca como "enviado a
  borradores", no como publicado.
- **Posteo directo (auditada):** TikTok puede tardar unos minutos en procesarlo. Límite aproximado de
  **15 publicaciones por día** por cuenta.

## Límites

- Video de 23 a 60 fps, entre 360 y 4096 px de lado, hasta 4 GB.
- Duración máxima: la que permita tu cuenta (la app la muestra; por API, hasta 10 minutos).

## Si falla

- **"redirect_uri mismatch":** el Redirect URI del PASO 3 no es exactamente `http://127.0.0.1:8723/`
  en la plataforma Desktop.
- **"scope_not_authorized":** falta aprobar o agregar un permiso, o tildaste **Mi app de TikTok pasó la
  auditoría** antes de tiempo. Destildalo, tocá **Guardar** y **Conectar**.
- **"unaudited_client_can_only_post_to_private_accounts":** la app todavía no está auditada. Destildá
  **Mi app de TikTok pasó la auditoría**, tocá **Guardar** y reconectá (modo borradores).
- **"spam_risk_too_many_posts":** llegaste al límite del día; reintentá mañana.
- **"spam_risk_too_many_pending_share":** publicá o borrá los borradores pendientes en TikTok.
- **El navegador no vuelve a la app:** otro programa puede estar usando el puerto 8723; cerralo o
  reiniciá la PC y tocá **Conectar** de nuevo.
