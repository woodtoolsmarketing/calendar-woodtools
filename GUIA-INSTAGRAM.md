# Guía: conectar Instagram (inicio de sesión con Instagram)

**Ya no hay que copiar el token a mano:** en la app tocás **Conectar**, iniciás sesión con Instagram
y listo. El token dura 60 días y **la app lo renueva sola cada semana**. Pegar un token queda como plan B.

Para que las publicaciones sean públicas y la conexión no se corte, completá también
[GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md).

Datos de tu app:
- App: **Calendario WT** (ID `27465335773102548`)
- App de Instagram: **Calendario WT-IG** (ID `1494449919030526`)
- Cuenta de Instagram: **@woodtoolssrl**

---

## Requisito

La cuenta tiene que ser **profesional** (mejor *Empresa*): Instagram → Configuración → *Tipo de cuenta
y herramientas* → *Cambiar a cuenta profesional*. Con este método no hace falta vincularla a la Página
de Facebook.

---

## PARTE 1: configurar la app de Instagram (panel de Meta)

1. https://developers.facebook.com/apps/27465335773102548/ → **Casos de uso** → **Personalizar** en
   *Administrar mensajes y contenido en Instagram*.
2. Entrá a **Configuración de la API con inicio de sesión con Instagram**.
3. **Permisos:** `instagram_business_basic` y `instagram_business_content_publish`.
4. Copiá el **Identificador de la app de Instagram** y la **Clave secreta de la app de Instagram**
   (no son el App ID de Meta).
5. **Configurar el inicio de sesión para empresas** → **URI de redireccionamiento de OAuth:**
   ```
   https://calendario-woodtools.onrender.com/oauth/callback.html
   ```
   Tiene que quedar **exactamente igual**. Si pide URL para desautorizar o para eliminación de datos,
   poné `https://calendario-woodtools.onrender.com/data-deletion.html`. **Guardar**.

---

## PARTE 2: agregar la cuenta como evaluador

1. En la misma pantalla, **Generar tokens de acceso → Agregar cuenta** → iniciá sesión con
   **@woodtoolssrl** y aceptá.
2. Si queda como invitación *pendiente*, aceptala desde Instagram con @woodtoolssrl:
   - **Celular:** perfil → **☰** → **Configuración y privacidad** → **Apps y sitios web** →
     **Invitaciones de evaluador** → **Aceptar**.
   - **Computadora (instagram.com):** **Configuración** → **Apps y sitios web** → **Invitaciones de
     evaluador** → **Aceptar**.

   (También se puede invitar desde **Roles de la app → Roles → Evaluadores de Instagram**.)

---

## PARTE 3: conectar en la app

1. Calendario WoodTools → **⚙ Conexiones → Instagram**.
2. Pegá el **ID** y la **clave secreta de la app de Instagram**. El campo del redirect solo se completa
   si registraste otra dirección en la PARTE 1. Tocá **Guardar**.
3. Tocá **Conectar** → iniciá sesión con @woodtoolssrl → **Permitir**.
4. El estado muestra **@woodtoolssrl** y la fecha de vencimiento. Probá con **📤 Publicar ahora** en
   una tarea con una foto.

**Renovación:** automática cada semana mientras la PC se prenda. Solo vence si la PC no se prende
durante **2 meses**. En ese caso, tocá **Conectar** otra vez.

**Que se vea en público:** Instagram usa la misma app de Meta. Pasala a **Live** (sección 2.3 de la
guía maestra) y abrí la publicación en una ventana de incógnito para confirmar.

---

## Plan B: pegar el token

1. En **Generar tokens de acceso**, al lado de @woodtoolssrl, **Generar token** → copialo.
2. En la app: **⚙ Conexiones → Instagram → Pegar token manualmente** → **Usar este token**. La app lo
   valida, guarda el vencimiento y
   lo renueva sola igual que con **Conectar**.

---

## Cómo publicar

- Tarea de Tipo **Contenido de redes** → tildá **Instagram** → formato (Publicación de foto, Reel o
  Historia) → **Publicar automático** → **📎 Elegir archivo** → epígrafe.
- La app sube el archivo a **Cloudinary** (tiene que estar configurado: sección 1 de la guía maestra)
  y convierte las fotos a **JPG** sola.
- **Fotos:** proporción entre 4:5 (vertical) y 1,91:1 (horizontal), hasta 8 MB.
- **Reels:** MP4 o MOV, de 3 segundos a 15 minutos. Con Cloudinary gratis, hasta 100 MB.
  Podés elegir una imagen de portada.
- **Historias:** foto, o video de hasta 60 segundos y 100 MB.
- **Epígrafe:** hasta 2.200 caracteres y 30 hashtags.
- **Límite diario:** Instagram permite unas 50 publicaciones por API cada 24 horas.

### Historias con link

Instagram **no permite** agregar el sticker de link por API. Si la historia lleva link, elegí
**Recordarme y lo subo yo** y subila vos con el link puesto.

---

## Si algo falla

- **"Invalid redirect_uri" o no vuelve a la app:** el URI de la PARTE 1, paso 5, no coincide exacto.
- **La ventana de Instagram no deja autorizar:** la invitación de evaluador no está aceptada (PARTE 2).
- **"Instagram necesita reconectarse":** tocá **Conectar** otra vez.
- **Nadie más ve lo publicado:** la app de Meta sigue en modo Desarrollo (guía maestra, 2.3).
- **Error de formato de archivo:** usá JPG/PNG para fotos y MP4/MOV para videos (WebM no sirve).
