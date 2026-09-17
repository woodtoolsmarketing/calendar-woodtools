# Guía: conectar Facebook (app de Meta)

Esta guía conecta la **Página de Facebook de WoodTools**. Para Instagram seguí
[GUIA-INSTAGRAM.md](GUIA-INSTAGRAM.md). Threads, el paso a **Live** y todo lo necesario para que las
publicaciones sean públicas y la conexión no se corte están en
[GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md).

**Ya no hace falta copiar tokens del Explorador de la API Graph.** La app tiene un botón **Conectar**
que abre el inicio de sesión de Facebook y guarda un **token de Página que no vence**. Pegar un token
a mano queda como plan B.

---

## Paso 0: requisitos (5 min)

1. Una **Página** de Facebook de WoodTools (no un perfil personal) en la que tengas control total o
   permiso para crear contenido.
2. Tu usuario de Facebook con rol de **administrador** en la app de Meta.

---

## Paso 1: crear la app (solo si todavía no existe)

Si ya tenés la app **Calendario WT**, pasá al Paso 2.

1. Entrá a https://developers.facebook.com/ con tu Facebook y aceptá los términos si te lo pide.
2. **Mis apps → Crear app**.
3. Caso de uso: **Administrar todo en tu Página**.
4. Nombre: *Calendario WoodTools*. Si te pide un portafolio comercial, elegí el de WoodTools.

---

## Paso 2: permisos e inicio de sesión (10 min)

1. **Casos de uso → Personalizar** (el de Páginas) → **Permisos**: tienen que estar
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` y `business_management`.
2. Configuración de **Inicio de sesión con Facebook**:
   - **Inicio de sesión con OAuth del cliente:** Sí
   - **Inicio de sesión con OAuth en el navegador insertado:** Sí
   - **Usar modo estricto para URI de redireccionamiento:** Sí
   - **URI de redireccionamiento de OAuth válidos:** `https://www.facebook.com/connect/login_success.html`
3. **Configuración de la app → Básica**: completá nombre visible, correo de contacto, ícono
   (`assets/icon-1024.png`), categoría y las URL de privacidad, términos y eliminación de datos
   (están en la tabla de [GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md)).
4. En esa misma pantalla copiá:
   - **Identificador de la app** = `App ID`
   - **Clave secreta de la app** = `App Secret` (clic en *Mostrar*)

---

## Paso 3: conectar en la app (2 min)

1. Abrí Calendario WoodTools → **⚙ Conexiones → Facebook**.
2. Pegá **App ID** y **App Secret**. Si administrás más de una Página, poné también el **ID de la Página**.
   Tocá **Guardar**.
3. Tocá **Conectar** → se abre la ventana de Facebook → iniciá sesión → **Continuar** → elegí la
   **Página de WoodTools** → aceptá los permisos.
4. El estado muestra el nombre de la Página y que el **token no vence**.
   Si aparece una fecha de vencimiento, tocá **Conectar** otra vez.

---

## Paso 4: que se vea en público

Mientras la app de Meta esté en **modo Desarrollo**, lo que publiques **solo lo ven las personas con
rol en la app**. Pasala a **Live** siguiendo la sección 2.3 de
[GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md) y después, en **⚙ Conexiones → Facebook**,
tildá **Mi app de Meta ya está publicada (modo Live)** → **Guardar**. Hasta entonces la app te lo recuerda
con un aviso.

---

## Plan B: pegar un token

Usalo solo si el botón **Conectar** no funciona.

**Opción A (recomendada): token de usuario del sistema.** No depende de tu sesión de Facebook.
1. https://business.facebook.com/ → **Configuración → Usuarios → Usuarios del sistema → Agregar**
   (rol Administrador).
2. **Asignar activos**: la **Página de WoodTools** (control total o crear contenido) y la **app de Meta**.
3. **Generar token** → elegí la app → vencimiento **Nunca** → permisos `pages_show_list`,
   `pages_read_engagement`, `pages_manage_posts` y `business_management` → copiá el token.
4. En la app: **⚙ Conexiones → Facebook → Pegar token manualmente** → pegalo → **Usar este token**.

**Opción B: token de usuario del Explorador de la API Graph.**
1. https://developers.facebook.com/tools/explorer/ → elegí la app → **User Token** → agregá los 4
   permisos de arriba → **Generate Access Token** → copialo.
2. En la app, con el **App Secret** ya guardado: **⚙ Conexiones → Facebook → Pegar token manualmente**
   → **Usar este token**. La app lo
   convierte en un token de Página que no vence.

---

## Cómo publicar

- En una tarea, Tipo **Contenido de redes** → tildá **Facebook** (y las demás redes) → formato
  (Publicación de foto, Publicación de video, Reel o Historia).
- **📎 Elegir archivo** desde la PC, escribí el **epígrafe** y, si querés, un **link**.
- Modo **Publicar automático**: a la hora programada la app publica sola. También podés usar
  **📤 Publicar ahora**.
- No hace falta conseguir un link público del archivo: a Facebook la app lo sube directo desde la PC.
  Instagram, Threads y las historias armadas con una URL pegada (en vez de un archivo) usan
  **Cloudinary**, que tiene que estar configurado (sección 1 de
  [GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md)). No hay hosting gratuito de reemplazo.

### Historias con link

Ni Facebook ni Instagram permiten agregar el sticker de link a una historia por API. Si la historia
lleva link, elegí **Recordarme y lo subo yo** (o tildá **recordarme subir una historia con link** en la
publicación): la app te avisa (Trascendental) y la subís vos con el link.

### Límites

- **Reels de Facebook:** de 3 a 90 segundos, vertical 9:16, hasta 30 por día publicados por API.
- **Fotos:** Facebook rechaza fotos de más de 4 MB.
- **Historias en video:** vertical, hasta 60 segundos.
- **La programación la hace la app:** la PC tiene que estar prendida a la hora programada (ver
  "Qué pasa si la PC está apagada" en la guía maestra).

---

## Si algo falla

- **Nadie más ve lo publicado:** la app de Meta está en modo Desarrollo (Paso 4).
- **"El token de Facebook vence el …":** tocá **Conectar** otra vez con el App Secret cargado, o usá
  el token de usuario del sistema (Plan B).
- **Falta permiso / no se puede publicar en la Página:** volvé a **Conectar**, elegí la Página de
  WoodTools y aceptá todos los permisos. Verificá que tu usuario pueda crear contenido en la Página.
- **La ventana de Facebook dice "URL bloqueada" o "función no disponible":** revisá el Paso 2, punto 2
  (OAuth del cliente, navegador insertado y el URI de redireccionamiento exacto).
- **"Sin conexión a internet o servicio caído":** no hace falta reconectar; reintentá más tarde.
