# Conexiones definitivas: checklist maestro

Con esta guía cada red queda **conectada de forma permanente** y **publicando en público**.
Casi todo se hace **una sola vez** en el panel de cada plataforma. Después la app renueva los
accesos sola y te avisa si algo necesita tu atención: notificación de Windows, panel
**⚙ Conexiones** y opción **Estado de conexiones** del ícono de la bandeja.

Guías con más detalle y cómo publicar en cada red: [GUIA-META.md](GUIA-META.md) (Facebook) ·
[GUIA-INSTAGRAM.md](GUIA-INSTAGRAM.md) · [GUIA-YOUTUBE.md](GUIA-YOUTUBE.md) ·
[GUIA-TIKTOK.md](GUIA-TIKTOK.md). Threads y Cloudinary están completos acá.

---

## Resumen

| Red | Qué hace la app sola | Qué tenés que hacer vos (una vez) | Mientras no lo completes |
|---|---|---|---|
| Facebook | Pide un **token de Página que no vence**, lo revisa cada 6 h y avisa si deja de andar. | Completar la app de Meta, pasarla a **Live**, tocar **Conectar** y tildar **modo Live**. | Lo publicado solo lo ven las personas con rol en la app de Meta. |
| Instagram | **Renueva el token cada semana** y lo revisa. | Configurar el inicio de sesión con Instagram, registrar el redirect y tocar **Conectar**. | No se puede conectar. |
| Threads | **Renueva el token cada semana** (y con eso, los permisos). | Caso de uso de Threads, invitación de evaluador aceptada, perfil público y **Conectar**. | No se puede conectar. |
| YouTube | Renueva el acceso todos los días y detecta si Google lo cortó. | **Publicar app** en Google, verificar el canal y mandar la **auditoría de la API**. | En modo *Prueba* se desconecta cada 7 días. Sin auditoría, los videos quedan **privados**. |
| TikTok | Renueva el token todos los días y avisa un mes antes de que haya que reconectar (una vez por año). | App con Direct Post, verificación de URL, **revisión de la app** y **auditoría** de Content Posting API. | Los videos llegan a tus **borradores** de TikTok y los publicás vos desde la app de TikTok. |
| Cloudinary | Sube las fotos y videos cuando Instagram, Threads o las historias de Facebook los necesitan. | Crear la cuenta y un *upload preset* sin firmar. | No se puede publicar en Instagram, Threads ni historias de Facebook. |

## Datos para copiar y pegar

| Qué | Valor |
|---|---|
| Sitio web | `https://calendario-woodtools.onrender.com/` |
| Política de privacidad | `https://calendario-woodtools.onrender.com/privacy.html` |
| Términos del servicio | `https://calendario-woodtools.onrender.com/terms.html` |
| Instrucciones de eliminación de datos | `https://calendario-woodtools.onrender.com/data-deletion.html` |
| Redirect de Instagram y Threads | `https://calendario-woodtools.onrender.com/oauth/callback.html` |
| Redirect de Facebook | `https://www.facebook.com/connect/login_success.html` |
| Redirect de TikTok (escritorio) | `http://127.0.0.1:8723/` |
| Ícono 1024×1024 | `assets/icon-1024.png` (carpeta del proyecto) |

**Orden recomendado:** 1 Cloudinary → 2 Facebook → 3 Instagram → 4 Threads → 5 YouTube → 6 TikTok.
Las revisiones de YouTube y TikTok tardan semanas: **mandalas cuanto antes**.

> En **⚙ Conexiones (redes)**, completá los datos de la app de cada red, tocá **Guardar** y después **Conectar**.
> **Desconectar** borra solo los tokens: los ID y claves de la app quedan guardados.

---

## 1. Cloudinary (hosting de archivos)

Instagram, Threads y las historias de Facebook **no aceptan archivos de tu PC**: necesitan un link
público. La app sube el archivo a tu cuenta de Cloudinary y le pasa ese link a la red.

1. Creá una cuenta gratis en https://cloudinary.com/ (no pide tarjeta).
2. En https://console.cloudinary.com/ copiá el **Cloud name** (aparece en el Dashboard).
3. Andá a **Settings (⚙) → Upload → Upload presets → Add upload preset** y configurá:

   | Opción | Valor |
   |---|---|
   | Signing mode | **Unsigned** |
   | Asset folder | `calendario-wt` |
   | Unique filename | activado |
   | Disallow public ID | activado |
   | Allowed formats | `jpg,jpeg,png,webp,heic,mp4,mov` |
   | Max file size | `100000000` (100 MB, plan gratis) |
   | Incoming transformation | vacío |

4. **Save** y copiá el **nombre del preset**.
5. En la app: **⚙ Conexiones → Cloudinary (hosting de archivos)** → pegá **Cloud name** y **Upload preset** → **Guardar**.
   - Plan gratis: dejá vacíos los máximos (la app asume videos de hasta 100 MB y te lo recuerda).
   - Plan pago: poné los límites de tu plan (por ejemplo Plus: video 2000 MB, imagen 20 MB).
6. Una vez por mes, en **Media Library → carpeta `calendario-wt`**, borrá los archivos ya publicados
   (las redes ya los descargaron).

> Videos de más de 100 MB con el plan gratis: exportalos más livianos (por ejemplo 1080p) o pasá a un plan pago.

---

## 2. Facebook (app de Meta): público y permanente

Requisitos: sos **administrador de la app de Meta** (developers.facebook.com) y tenés control total
(o permiso para crear contenido) en la **Página de WoodTools**.

### 2.1 Configuración básica

1. https://developers.facebook.com/apps → abrí la app → **Configuración de la app → Básica**.
2. Completá:
   - **Nombre visible:** Calendario WoodTools
   - **Correo electrónico de contacto:** el mail de la empresa
   - **Ícono de la app:** `assets/icon-1024.png`
   - **Categoría:** Negocios y páginas (o Productividad)
   - **URL de la Política de privacidad**, **URL de las Condiciones del servicio** y
     **URL de instrucciones de eliminación de datos**: las de la tabla de arriba.
   - **Propósito de la app:** tu propia empresa.
3. **Guardar cambios**.
4. En **Configuración → Avanzada**, dejá **App nativa o de escritorio** en **No** (si lo activás,
   la app no puede comprobar si el token vence).

### 2.2 Inicio de sesión con Facebook

1. **Casos de uso** → el caso de uso de Páginas (*Administrar todo en tu Página*) → **Personalizar →
   Permisos**: tienen que estar `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` y
   `business_management`.
2. Abrí la configuración de **Inicio de sesión con Facebook** (dentro del caso de uso, o en
   *Productos → Inicio de sesión con Facebook → Configuración* en apps más viejas) y dejá:
   - **Inicio de sesión con OAuth del cliente:** Sí
   - **Inicio de sesión con OAuth en el navegador insertado:** Sí
   - **Usar modo estricto para URI de redireccionamiento:** Sí
   - **URI de redireccionamiento de OAuth válidos:** `https://www.facebook.com/connect/login_success.html`
3. **Guardar cambios**.

### 2.3 Pasar la app a Live (Publicar)

En modo **Desarrollo**, lo que la app publica **solo lo ven las personas con rol en la app**
(administradores, desarrolladores, evaluadores). Tus seguidores no lo ven.

1. Arriba del panel (o en el menú **Publicar**), cambiá el modo de **Desarrollo** a **Activo (Live)** → **Publicar**.
2. Si marca pendientes, casi siempre son datos del paso 2.1: completalos y reintentá.
3. **Si te exige Revisión de la app** para `pages_manage_posts` (la documentación de Meta se contradice en esto):
   1. **Revisión de la app → Solicitudes** → pedí `pages_manage_posts`, `pages_read_engagement`,
      `pages_show_list` y `business_management`.
   2. Si pide **Verificación del negocio**: *Configuración → Básica → Verificación* con los datos y
      documentos de WoodTools.
   3. Descripción de uso (pegala en inglés en cada permiso):
      > Calendario WoodTools is WoodTools' internal Windows desktop application. Our marketing team
      > uses it to schedule and publish content to the company's own Facebook Page.
      > pages_manage_posts creates the posts, photos, videos, reels and stories on our Page at the
      > time scheduled by the team. pages_show_list and pages_read_engagement list the Pages the user
      > manages so they can choose the WoodTools Page and read its name and ID. business_management is
      > required to access the Page owned by our business portfolio. The app does not access Pages of
      > other businesses.
   4. **Video (screencast):** abrir la app → **⚙ Conexiones → Facebook → Conectar** → iniciar sesión y
      elegir la Página → crear una tarea con foto (**Publicar automático**) → **Guardar** → abrirla →
      **📤 Publicar ahora** → mostrar la publicación en la Página.
   5. **Instrucciones para el revisor:** *"Windows desktop app used by WoodTools' marketing team. The
      screencast shows the complete flow. The app only publishes to the WoodTools Page."*
4. Si tu app es de tipo **Empresa** y no tiene selector de modo, seguí con 2.4 y confirmá la visibilidad en el paso 5 de 2.4.

### 2.4 Conectar en la app

1. **⚙ Conexiones → Facebook**: pegá **App ID** y **App Secret** (*Configuración → Básica*, la clave con
   *Mostrar*). Si administrás varias Páginas, poné también el **ID de la Página** de WoodTools → **Guardar**.
2. Tocá **Conectar** → se abre la ventana de Facebook → iniciá sesión → **Continuar** → elegí la
   **Página de WoodTools** → aceptá los permisos.
3. El estado tiene que decir que el **token de Página no vence**. Si muestra una fecha de vencimiento,
   tocá **Conectar** otra vez.
4. Tildá **Mi app de Meta ya está publicada (modo Live)** (solo después de 2.3) → **Guardar**.
5. Prueba: publicá algo con **📤 Publicar ahora** y abrí la publicación en una **ventana de incógnito
   sin iniciar sesión**. Si la ves, es pública.

> Plan B sin ventana de login: token de **usuario del sistema** (ver [GUIA-META.md](GUIA-META.md), "Plan B"),
> pegado en **Pegar token manualmente**.

---

## 3. Instagram

Requisito: la cuenta de Instagram de WoodTools en modo **profesional** (Empresa). Con este método no
hace falta vincularla a la Página de Facebook.

1. Panel de Meta → **Casos de uso → Instagram** (*Administrar mensajes y contenido en Instagram*) →
   **Personalizar → Configuración de la API con inicio de sesión con Instagram**.
2. **Permisos:** `instagram_business_basic` y `instagram_business_content_publish`.
3. Copiá el **Identificador de la app de Instagram** y la **Clave secreta de la app de Instagram**
   (son distintos del App ID de Meta).
4. **Configurar el inicio de sesión para empresas** → **URI de redireccionamiento de OAuth:**
   `https://calendario-woodtools.onrender.com/oauth/callback.html` → **Guardar**. Tiene que quedar
   **exactamente igual**. Si pide URL para desautorizar o para eliminación de datos, poné
   `https://calendario-woodtools.onrender.com/data-deletion.html`.
5. **Generar tokens de acceso → Agregar cuenta** → iniciá sesión con la cuenta de WoodTools y aceptá.
   Si queda *pendiente*, aceptá la invitación de evaluador en Instagram (pasos en [GUIA-INSTAGRAM.md](GUIA-INSTAGRAM.md)).
6. En la app: **⚙ Conexiones → Instagram** → pegá el ID y la clave de la app de Instagram (el redirect
   dejalo como viene) → **Guardar** → **Conectar** → iniciá sesión → **Permitir**.
7. El estado muestra el **@usuario** y la fecha de vencimiento.

**Renovación:** el token dura 60 días y la app **lo renueva sola cada semana** mientras la PC se prenda.
Solo vence si la PC **no se prende durante 2 meses**. En ese caso, tocá **Conectar** otra vez.

**Visibilidad:** usa la misma app de Meta, así que hacé también el paso 2.3 (Live) y probá en incógnito.

---

## 4. Threads

Requisito: perfil de Threads de WoodTools **público**.

1. Panel de Meta → **Casos de uso → Agregar caso de uso → Acceder a la API de Threads** (en la misma
   app; si no te deja, creá una app nueva solo para Threads).
2. **Personalizar → Permisos:** `threads_basic` y `threads_content_publish` (tienen que decir *Listo para la prueba*).
3. **Personalizar → Configuración**:
   1. Copiá el **Identificador de la app de Threads** y la **Clave secreta de la app de Threads**
      (no son los de *Configuración → Básica*).
   2. **URL de devolución de llamada de redireccionamiento:**
      `https://calendario-woodtools.onrender.com/oauth/callback.html` (apretá Enter para que quede agregada).
   3. **URL para desautorizar** y **URL de solicitud de eliminación de datos:**
      `https://calendario-woodtools.onrender.com/data-deletion.html`.
   4. **Guardar**.
4. **Roles de la app → Roles → Agregar personas → Evaluador de Threads** → escribí el usuario de Threads de WoodTools.
5. Con la cuenta de WoodTools en Threads (web o celular): **Configuración → Cuenta → Permisos del sitio
   web → Invitaciones** → **Aceptar**.
6. Threads → **Configuración → Privacidad** → **Perfil privado: desactivado**.
7. En la app: **⚙ Conexiones → Threads** → pegá el ID y la clave de la app de Threads → **Guardar** → **Conectar** →
   iniciá sesión → **Permitir**.

**Renovación:** automática. El token dura 60 días y se renueva cada semana; cada renovación también
extiende los permisos de 90 días (solo con perfil público).

**Visibilidad:** Threads sigue las reglas de la app de Meta: pasala a Live (2.3) y probá en incógnito.
Si igual no se ve en público, pedí Revisión de la app para `threads_basic` y `threads_content_publish`.

**Error "Invalid redirect_uri":** casi siempre es que la invitación del paso 5 no está aceptada.

---

## 5. YouTube

Requisito: proyecto de Google Cloud con **YouTube Data API v3** y un **cliente OAuth de escritorio**
(pasos en [GUIA-YOUTUBE.md](GUIA-YOUTUBE.md)).

### 5.1 Que no se desconecte cada 7 días

1. https://console.cloud.google.com/ → proyecto *Calendario WoodTools* → **Google Auth Platform → Público**.
2. **Estado de publicación: Prueba** → **Publicar app** → **Confirmar**. Tiene que quedar **En producción**.
3. No pidas verificación ni subas logo (con logo, Google exige verificar la app). Para uso propio no hace falta.
4. En la app: **⚙ Conexiones → YouTube → Conectar**. Se abre **tu navegador**:
   1. Elegí la cuenta (o el canal de marca) de WoodTools.
   2. Aviso *"Google no verificó esta app"* → **Configuración avanzada** → **Ir a Calendario WoodTools (no seguro)**.
   3. **Tildá los dos permisos** (videos y cuenta de YouTube) → **Continuar**.
   4. Cuando el navegador diga que ya podés cerrar la pestaña, volvé a la app.

   Si ya estaba conectado cuando la app de Google estaba en *Prueba*, conectá otra vez.

### 5.2 Verificar el canal

1. Entrá a https://www.youtube.com/verify con la cuenta del canal → código por SMS o llamada.
2. Esto habilita **miniaturas personalizadas** y **videos de más de 15 minutos**.

### 5.3 Auditoría de la API de YouTube (para que los videos sean públicos)

Google deja como **privado (bloqueado)** todo video subido por la API desde un proyecto **no auditado**.
No se puede apelar: esos videos hay que volver a subirlos después de la aprobación. Mientras tanto,
los videos que tengan que salir públicos subilos a mano desde YouTube Studio.

1. Prepará estas capturas:
   - [ ] Pantalla de consentimiento de Google con "Calendario WoodTools" y los permisos.
   - [ ] Formulario de tarea con el bloque de YouTube: título, descripción y **visibilidad** elegida
         (Público / No listado / Privado) antes de publicar, y la ventana de confirmación de
         **📤 Publicar ahora**, que repite la visibilidad.
   - [ ] Link a la **Política de privacidad** dentro de la app (al pie de la barra lateral y de **⚙ Conexiones**).
   - [ ] Página de inicio del sitio con el link a Privacidad, y la Política de privacidad.
   - [ ] **Número de proyecto** de Google Cloud (en el Panel del proyecto).
2. Abrí https://support.google.com/youtube/contact/yt_api_form y completá:

   | Campo | Español | English |
   |---|---|---|
   | Organización | WoodTools | WoodTools |
   | Sitio web / URL de acceso | https://calendario-woodtools.onrender.com/ | https://calendario-woodtools.onrender.com/ |
   | Nombre del cliente de API | Calendario WoodTools | Calendario WoodTools |
   | Política de privacidad | https://calendario-woodtools.onrender.com/privacy.html | https://calendario-woodtools.onrender.com/privacy.html |
   | Términos del servicio | https://calendario-woodtools.onrender.com/terms.html | https://calendario-woodtools.onrender.com/terms.html |
   | ¿Acceso público? | No. Aplicación de escritorio para Windows de uso interno del equipo de marketing de WoodTools. | No. Windows desktop application used internally by WoodTools' marketing team. |
   | Proyectos de Google Cloud | Uno solo (número de proyecto) | Only one (project number) |
   | Categorías de uso | Subida de videos; herramientas internas | Video uploading; Internal tools |
   | Métodos de la API | videos.insert, thumbnails.set, channels.list, videos.list | videos.insert, thumbnails.set, channels.list, videos.list |
   | Permisos OAuth | youtube.upload, youtube.readonly | youtube.upload, youtube.readonly |
   | Volumen esperado | Unas 10 subidas por semana, 1 canal | About 10 uploads per week, 1 channel |
   | Cuota adicional | No hace falta | Not needed |
   | Credenciales de demo | No aplica (app de escritorio); podemos enviar un video de demostración | Not applicable (desktop app); we can provide a demo video |

3. **Modelo de negocio / caso de uso** (completá la primera frase con a qué se dedica la empresa):

   **Español**
   > WoodTools es una empresa que [a qué se dedica] y publica el contenido de su marca en su canal
   > oficial de YouTube. Calendario WoodTools es nuestra herramienta interna: una aplicación de
   > escritorio para Windows que usa el equipo de marketing para planificar tareas y programar la
   > publicación del contenido de la empresa en sus propias cuentas. Para YouTube, la aplicación sube
   > los videos y Shorts de la empresa a su propio canal con videos.insert, con el título, la
   > descripción y la visibilidad (público, no listado o privado) que el equipo elige y ve antes de
   > confirmar; agrega la miniatura con thumbnails.set; usa channels.list para mostrar con qué canal
   > está conectada y videos.list para confirmar el estado del video subido. No es un servicio para
   > terceros: solo se conecta al canal de WoodTools y no muestra datos de YouTube a otras personas.
   > No tiene servidores: el token y el nombre del canal se guardan solo en la PC de la empresa, se
   > actualizan a diario y se borran al desconectar. No hay publicidad ni monetización en la aplicación.

   **English**
   > WoodTools is a company that [what the company does] and publishes its brand content on its
   > official YouTube channel. Calendario WoodTools is our internal tool: a Windows desktop application
   > that our marketing team uses to plan tasks and schedule the publication of the company's content
   > to its own accounts. For YouTube, the application uploads the company's videos and Shorts to its
   > own channel with videos.insert, using the title, description and visibility (public, unlisted or
   > private) that the team chooses and sees before confirming; it sets the thumbnail with
   > thumbnails.set; it uses channels.list to show which channel is connected and videos.list to
   > confirm the status of the uploaded video. It is not a service for third parties: it only connects
   > to the WoodTools channel and does not display YouTube data to other people. It has no servers: the
   > token and channel name are stored only on the company's PC, refreshed daily and deleted on
   > disconnect. There is no advertising or monetization in the application.

4. **Enviar.** Google responde por mail (puede tardar semanas y pedir más datos: contestá en el mismo hilo).
5. Cuando aprueben: **⚙ Conexiones → YouTube** → tildá **Google aprobó la auditoría de la API de YouTube**
   → **Guardar**. El aviso desaparece.

**Para que dure siempre:** no borres ni regeneres la clave del cliente, no crees otro proyecto
(Google exige uno solo por aplicación) y dejá que la app se use al menos una vez cada 6 meses
(renueva el acceso cada día que la PC está prendida).

---

## 6. TikTok

Portal: https://developers.tiktok.com/ → **Manage apps**. Registrá la app a nombre de la
**organización** (WoodTools), no como individuo.

### 6.1 Configurar la app

1. **App details:**
   - Nombre: **Calendario WoodTools** (sin mencionar TikTok ni otras redes).
   - Ícono: `assets/icon-1024.png`.
   - Descripción (en inglés): *WoodTools' desktop tool to schedule and publish our brand videos.*
   - **Terms of Service URL** y **Privacy Policy URL**: las de la tabla de arriba.
2. **Platforms → Desktop** → URL: `https://calendario-woodtools.onrender.com/`.
3. **URL properties → Verify properties** → tipo **URL prefix** → `https://calendario-woodtools.onrender.com/`
   → **Download** del archivo `tiktok….txt`:
   1. Copialo a la carpeta `docs/` del proyecto (sin borrar el que ya está) y subilo al repositorio;
      Render publica el sitio solo.
   2. Abrí `https://calendario-woodtools.onrender.com/<nombre-del-archivo>.txt` para confirmar que se ve.
   3. **Verify**. (La opción *Domain* no sirve: en onrender.com no se pueden agregar registros DNS.)
4. **Products → Add products:** **Login Kit** y **Content Posting API**.
5. **Login Kit → Desktop → Redirect URI:** `http://127.0.0.1:8723/` (exacto, con la barra final).
6. **Content Posting API → Direct Post:** activado.
7. **Scopes:** `user.info.basic`, `video.upload`, `video.publish`.
8. Copiá **Client key** y **Client secret** (los de *Sandbox* para la demo; los de *Production* después de la aprobación).

### 6.2 Sandbox para la demo

1. Arriba, cambiá a **Sandbox → Create sandbox**.
2. **Target users → Add** → la cuenta de TikTok de WoodTools → iniciá sesión y aceptá los términos de
   desarrollador (puede tardar hasta 1 hora en aparecer).
3. En la app: **⚙ Conexiones → TikTok** → claves de Sandbox → tildá **Mi app de TikTok pasó la
   auditoría** (activa el posteo directo) → **Guardar** → **Conectar**.
4. Mientras TikTok no audite la app, el posteo directo solo funciona como **Solo yo** en una **cuenta
   privada**: poné la cuenta en privado durante la grabación y volvela a público al terminar.

### 6.3 Video de demostración (guion)

Una sola grabación de pantalla, sin cortes, 1080p, hasta 50 MB.

1. Mostrá el sitio `https://calendario-woodtools.onrender.com/` con los links de Privacidad y Términos.
2. Abrí **Calendario WoodTools** (que se vean el nombre y el ícono).
3. **⚙ Conexiones → TikTok → Conectar**.
4. En el navegador aparece la autorización de TikTok con el nombre de la app y los permisos → iniciá
   sesión → **Autorizar** → volvé a la app: TikTok conectado.
5. **+ Nueva tarea** → Tipo **Contenido de redes** → tildá **TikTok** → **Publicar automático** → elegí un
   video MP4 → escribí el texto con hashtags.
6. En el bloque de TikTok mostrá, de a uno:
   1. **Publicando como**: el apodo de la cuenta donde se va a publicar.
   2. El menú **¿Quién puede ver este video?** sin opción elegida → elegí **Solo yo** (en Sandbox es la
      única que funciona).
   3. Las casillas **Permitir comentarios / Dúo / Stitch** desmarcadas → marcá alguna (si la cuenta las
      tiene deshabilitadas, se ven grises).
   4. **Divulgar contenido comercial** apagado → encendelo → marcá **Contenido de marca** para mostrar que
      *Solo yo* se deshabilita y aparece la Política de contenido de marca → desmarcalo → marcá
      **Tu marca** → volvé a elegir **Solo yo** (se borra al marcar Contenido de marca).
   5. El texto **Al publicar, aceptás la Declaración de confirmación de uso de música de TikTok**.
   6. El aviso de que TikTok puede tardar unos minutos en procesar el video.
7. **Guardar** → abrí la tarea en el calendario → **📤 Publicar ahora** → la confirmación muestra quién
   va a poder verlo → **Aceptar** → resultado OK.
8. Abrí TikTok (web o celular) en el perfil y mostrá el video publicado.

### 6.4 Revisión de la app (App Review)

1. **App review** → completá los textos (en inglés) → subí el video → **Submit for review**.
   TikTok dice que tarda de varios días a dos semanas.
2. Textos:
   - **App:** *Calendario WoodTools is WoodTools' content planning and publishing tool, a complete Windows
     desktop application used by our marketing team to schedule and publish videos to the company's
     official TikTok brand account. Our website https://calendario-woodtools.onrender.com/ describes the
     product and links to the Privacy Policy and Terms of Service.*
   - **Login Kit:** *Connects the brand's TikTok account from the Connections panel (Desktop, PKCE, redirect
     http://127.0.0.1:8723/). The app shows the connected account's display name.*
   - **Content Posting API:** *Publishes the videos scheduled in the app. Before posting, the composer shows
     the creator's nickname, the privacy options returned by creator_info with no default, interaction
     settings, commercial content disclosure and the Music Usage Confirmation. The user can also send the
     video to TikTok drafts.*
   - **user.info.basic:** *Show which TikTok account is connected.*
   - **video.upload:** *Send a video to the creator's TikTok inbox as a draft to finish it in the TikTok app.*
   - **video.publish:** *Directly post the video to the connected account with the settings chosen by the user.*
3. **Evitá** palabras como *personal use*, *test*, *beta*, *prototype* u *only for me*. Presentala como
   la **herramienta de publicación interna de WoodTools para su cuenta de marca**, un producto terminado.

**Motivos de rechazo frecuentes:** que parezca de uso personal o en desarrollo, sitio incompleto,
nombre o ícono con referencias a TikTok, video que no muestra todos los permisos, links legales no
visibles. Si la rechazan, corregí lo que indiquen y volvé a enviarla.

### 6.5 Auditoría de Content Posting API (posteo directo público)

1. Con la app aprobada, entrá a https://developers.tiktok.com/application/content-posting-api.
2. Completá con los mismos textos, el mismo video y capturas del bloque de TikTok. Uso estimado:
   1 cuenta (la de WoodTools) y la cantidad real de videos por semana.
3. **Hasta que aprueben:** con las claves de *Production*, dejá **Mi app de TikTok pasó la auditoría**
   destildado → **Guardar** → **Conectar**. Los videos van a la **bandeja de borradores** de TikTok
   (hasta 5 pendientes cada 24 h) y los publicás desde la app de TikTok.
4. **Cuando aprueben:** **⚙ Conexiones → TikTok** → tildá **Mi app de TikTok pasó la auditoría** →
   **Guardar** → **Conectar** otra vez (así se agrega el permiso `video.publish`).

**Una vez por año** TikTok obliga a volver a autorizar: la app avisa 30 días antes. Tocá **Conectar**.

---

## 7. Qué pasa si la PC está apagada

- La app arranca con Windows y queda en la bandeja. **Solo publica con la PC prendida y con internet.**
- Si la PC estaba apagada a la hora programada:
  - Si la prendés **dentro de las 12 horas**, la app publica apenas arranca (tarde, pero sola).
  - Si pasaron **más de 12 horas** (hasta 7 días), no publica sola: **te avisa qué publicación se
    perdió**. Abrí la tarea y tocá **📤 Publicar ahora**.
- Si la publicación falla por un problema pasajero (sin internet, red caída), la app **reintenta sola**
  a los 5 min, 15 min, 1 h y 3 h.
- Cada vez que la PC arranca (y después cada 6 h) la app **revisa y renueva los tokens**.
- Si la PC queda apagada mucho tiempo:

  | Red | Qué pasa |
  |---|---|
  | Facebook | El token de Página no vence. |
  | Instagram y Threads | Vencen a los 60 días sin renovar: tocá **Conectar** otra vez. |
  | YouTube | Google corta el acceso si no se usa durante 6 meses. |
  | TikTok | Se renueva al prender la PC; la autorización vence al año de haber conectado. |

- Si hay que reconectar algo, llega una notificación y se ve en **Estado de conexiones** (ícono de la
  bandeja) y en **⚙ Conexiones**.
- Si publicás en horarios fijos, configurá Windows para que la PC no se suspenda en esos horarios.
