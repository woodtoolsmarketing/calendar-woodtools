# Guía: generar el Token de Instagram (método nuevo)

Este token es **distinto** al de la Página. Es el que permite **publicar** en Instagram
sin la revisión de semanas. Se hace **una vez** (después solo se renueva cada ~60 días).

Datos de tu app:
- App: **Calendario WT** (ID `27465335773102548`)
- App de Instagram: **Calendario WT-IG** (ID `1494449919030526`)
- Cuenta de Instagram: **@woodtoolssrl**

---

## PARTE 1 — Agregar tu Instagram como "evaluador" (en el panel de Meta)

1. Entrá a **https://developers.facebook.com/apps/27465335773102548/roles/roles/**
   (o: panel de la app → menú izquierdo **Roles de la app → Roles**).
2. Bajá hasta la sección **"Evaluadores de Instagram"** (Instagram Testers).
3. Clic en **"Agregar evaluadores de Instagram"**.
4. Escribí el usuario **`woodtoolssrl`** (sin @) → **Enviar / Agregar**.
   → Queda como invitación **"pendiente"**.

---

## PARTE 2 — Aceptar la invitación (desde tu cuenta de Instagram)

Esto se hace en **Instagram**, NO en el panel de Meta. Con la cuenta **@woodtoolssrl**:

**Desde la app de Instagram (celular):**
1. Tu perfil → menú **☰** (arriba a la derecha) → **Configuración y privacidad**.
2. Buscá **"Aplicaciones y sitios web"** (o "Apps and websites").
3. Pestaña **"Invitaciones de evaluador"** (Tester invites).
4. **Aceptá** la invitación de **Calendario WT**.

**Desde la computadora (instagram.com):**
1. Entrá a instagram.com con @woodtoolssrl.
2. **Configuración** → **Aplicaciones y sitios web** → **Invitaciones de evaluador** → **Aceptar**.

---

## PARTE 3 — Generar el token y pegarlo en la app

1. Volvé al panel de Meta → **Casos de uso** → **Personalizar** (el de Instagram:
   *"Administrar mensajes y contenido en Instagram"*).
2. En el menú del caso de uso, elegí **"Configuración de la API con inicio de sesión con Instagram"**.
3. Buscá el bloque **"2. Generar tokens de acceso"** → clic en **"Agregar cuenta"**.
4. Se abre una ventana de Instagram → iniciá sesión con **@woodtoolssrl** → **autorizá TODOS los permisos**.
5. Cuando vuelvas, vas a ver tu cuenta listada con un **token de acceso**. Clic en **mostrar/copiar** el token (es largo) y **copialo**.
6. Abrí la app **Calendario WoodTools** → **⚙ Conexiones** → pegá el token en el campo
   **"Token de Instagram (método nuevo, para publicar)"**.
7. **Guardar conexión** → **Probar conexión**.

✅ Si el diagnóstico dice **"Token de IG OK → @woodtoolssrl ✅"**, ya está. Probá con
**📤 Publicar ahora** en una tarea de contenido con una imagen.

---

## Si algo falla

- **No aparece el token / dice que falta permiso de publicar:** verificá que en
  **Personalizar (Instagram) → Permisos y funciones** esté **`instagram_business_content_publish`**
  en estado *"Listo para la prueba"* (ya lo tenías). Si no, agregalo.
- **"Agregar cuenta" no hace nada / no abre el login:** primero tiene que estar aceptada la
  invitación de evaluador (Parte 2). Reintentá después de aceptar.
- **El token vence:** dura ~60 días. Más adelante te dejo que la app lo renueve sola.

> Nota: las fotos para Instagram tienen que ser **JPG** (no PNG). Para reels/historias, **MP4**.
> El archivo lo subís desde la app con **"📎 Elegir archivo"** y ella lo sube sola.
