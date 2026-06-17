# Guía: conectar Facebook + Instagram (Meta)

Esto se hace **una sola vez**. Al final vas a tener 5 datos para pegar en la app
(botón **⚙ Conexiones**). Para publicar en TUS cuentas no hace falta la revisión de
2-4 semanas: alcanza con el **modo desarrollo** y que seas administrador.

---

## Paso 0 — Requisitos de las cuentas (5 min)

1. **Instagram en modo Profesional**: abrí Instagram → Configuración → *Tipo de cuenta y herramientas* → *Cambiar a cuenta profesional* (Empresa o Creador).
2. **Vincular IG con una Página de Facebook**: necesitás una **Página** de Facebook (no un perfil personal) de WoodTools. En la Página → Configuración → *Cuentas vinculadas* → conectá tu Instagram. (O desde la app de IG: Configuración → *Compartir en otras apps* → Facebook.)

> Sin Página de Facebook + IG Profesional vinculado, Instagram **no** deja publicar por API. Es requisito de Meta.

---

## Paso 1 — Crear la app de desarrollador (10 min)

1. Entrá a **https://developers.facebook.com/** e iniciá sesión con tu Facebook.
2. Aceptá los términos de desarrollador (si te lo pide) y verificá tu cuenta con un mail o teléfono.
3. Arriba a la derecha: **Mis apps → Crear app**.
4. Caso de uso: elegí **"Otro"** → tipo **"Empresa / Business"** → continuar.
5. Ponele un nombre (ej: *Calendario WoodTools*) y creala.

---

## Paso 2 — Agregar los casos de uso (5 min)

El panel nuevo de Meta usa **"Casos de uso"** (antes eran "productos"). En el menú de la
izquierda: **Casos de uso → Agregar caso de uso**.

Para lo que arma la app (postear en Facebook e Instagram con un mismo token, usando
**Inicio de sesión con Facebook**), agregá:

1. El caso de uso de **Instagram** (algo como *"Gestionar mensajería y contenido en Instagram"*).
   ⚠️ Tiene que ser el que usa **Inicio de sesión con Facebook**, NO el de *"Instagram con
   Instagram Login"* — ese token no sirve para Facebook.
   - Dentro del caso de uso → pestaña **Permisos** → agregá: `instagram_basic` y `instagram_content_publish`.
2. Para tu **Página de Facebook**, agregá los permisos: `pages_show_list`,
   `pages_read_engagement`, `pages_manage_posts` (vienen con el caso de uso de Páginas /
   Facebook Login).
3. (Opcional, para después) **Threads** es un caso de uso aparte: permisos
   `threads_basic` y `threads_content_publish`.

En **Configuración → Básica** de la app vas a ver:
- **Identificador de la app** = `App ID`  ✅ (dato 1)
- **Clave secreta de la app** = `App Secret`  ✅ (dato 2) — hacé clic en *Mostrar*.

---

## Paso 3 — Obtener Página, token e Instagram (10 min)

Vamos a usar el **Explorador de la API Graph**: https://developers.facebook.com/tools/explorer/

1. Arriba a la derecha, en *Meta App*, elegí tu app.
2. En *User or Page*, dejá **User Token**.
3. Clic en **Add a permission** y tildá estos permisos:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`
4. Clic en **Generate Access Token** → te pide loguearte y aceptar. Aceptá todo.
5. Ahora, en la barra de consulta escribí: `me/accounts` y clic en **Submit**.
   - En la respuesta vas a ver tu Página. Copiá:
     - `id` = **ID de la Página** ✅ (dato 3)
     - `access_token` = **token de la Página** ✅ (dato 4)
6. Para el Instagram, consultá: `{ID-de-la-Página}?fields=instagram_business_account`
   (reemplazá por el id del paso anterior). En la respuesta:
   - `instagram_business_account.id` = **ID de la cuenta de Instagram** ✅ (dato 5)

---

## Paso 4 — Hacer el token de larga duración (importante)

El token del paso 3 dura ~1 hora. Para que dure ~60 días:

1. Andá al **Depurador de tokens**: https://developers.facebook.com/tools/debug/accesstoken/
2. Pegá el **token de la Página** y clic en *Depurar*.
3. Abajo clic en **Extender el token de acceso** (Extend Access Token).
4. Copiá el nuevo token largo: ese es el que va en la app.

> Aviso: los tokens de Meta vencen cada ~60 días. Cuando lo armemos del todo te puedo
> agregar un botón **"Conectar con Facebook"** que renueva el token solo (OAuth), así no
> tenés que repetir esto. Para arrancar y probar, con el pegado manual alcanza.

---

## Paso 5 — Pegar en la app

1. Abrí el Calendario WoodTools → **⚙ Conexiones**.
2. Pegá los 5 datos:

| Campo en la app | De dónde sale |
|---|---|
| App ID | Paso 2 |
| App Secret | Paso 2 |
| ID de la Página de Facebook | Paso 3.5 |
| Token de la Página | Paso 4 (el largo) |
| ID de la cuenta de Instagram | Paso 3.6 |

3. Clic en **Probar conexión**. Si ves *✅ Conectado. Página: … · IG: @…* ya está.
4. **Guardar conexión**.

---

## Cómo publicar

- En una tarea, elegí tipo **Contenido** → tildá las plataformas (Instagram / Facebook).
- En *¿Qué hago con esto?* elegí **Publicar automático**.
- Pegá la **URL pública del archivo** (imagen o video), el **epígrafe** y, para Facebook, un **link** opcional.
- Cuando llegue la hora, la app publica sola (la PC tiene que estar encendida y la app abierta o en la bandeja). También podés usar **📤 Publicar ahora**.

### Sobre la URL pública del archivo
Instagram **no** sube archivos de tu PC: necesita una URL pública (`https://...jpg` o `.mp4`).
Opciones rápidas: subirlo a tu sitio web, o a Google Drive/Dropbox con *enlace directo*.
Si querés, en la próxima etapa te armo que la app suba el archivo a un hosting solo.

### Historias con link (importante)
Instagram **no permite** agregar el sticker de link a una historia por API (lo bloquea para
todas las apps). El **archivo** de la historia sí se puede subir solo, pero el **link va a
mano** en la app de Instagram (5 segundos, y ya está disponible para todas las cuentas).
Por eso, cuando la historia lleva link, conviene dejarla en modo **recordatorio**: la app te
avisa (Trascendental) y la subís vos con el link puesto.

### Límites a tener en cuenta
- **Instagram**: ~25 publicaciones por día por cuenta.
- **Reels/Historias en video**: la app espera a que Instagram termine de procesar antes de publicar.
- **Facebook**: soporta programación nativa; Instagram lo programa la app.
