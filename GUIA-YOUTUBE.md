# Guía: conectar YouTube

Necesitás 2 datos (**Client ID** y **Client Secret**) de un proyecto de Google Cloud.
Se hace **una sola vez**. Después, en la app tocás "Conectar con YouTube" e iniciás sesión.

El video se sube **directo desde tu PC** (no necesita hosting). La programación es nativa:
si la tarea es a futuro, el video se sube como privado y YouTube lo publica a la hora exacta.

---

## PASO 1 — Crear el proyecto
1. Entrá a **https://console.cloud.google.com/** con tu cuenta de Google (la del canal de WoodTools).
2. Arriba a la izquierda, en el selector de proyectos → **Proyecto nuevo** → nombre: *Calendario WoodTools* → **Crear**.
3. Asegurate de que quede **seleccionado** ese proyecto (arriba).

## PASO 2 — Activar la API de YouTube
4. Menú ☰ → **APIs y servicios → Biblioteca**.
5. Buscá **"YouTube Data API v3"** → entrá → **Habilitar**.

## PASO 3 — Pantalla de consentimiento
6. Menú ☰ → **APIs y servicios → Pantalla de consentimiento de OAuth** (o "Google Auth Platform").
7. Tipo de usuario: **Externo** → **Crear**.
8. Completá: nombre de la app (*Calendario WoodTools*), correo de asistencia y de contacto (tu mail). Guardá y seguí (los demás pasos podés dejarlos por defecto).
9. **Importante (para que no se desconecte cada 7 días):** en **Público / Estado de publicación**, ponelo **"En producción"** (Publish app). Cuando conectes, Google va a mostrar una pantalla de *"app no verificada"* → clic en **"Configuración avanzada" → "Ir a Calendario WoodTools (no seguro)"** → continuar. Es normal porque sos vos el dueño.
   - *Alternativa más simple:* dejalo en **"Prueba (Testing)"** y agregá tu mail en **Usuarios de prueba**. Funciona igual, pero la conexión **dura 7 días** y hay que reconectar.

## PASO 4 — Crear las credenciales (Client ID + Secret)
10. Menú ☰ → **APIs y servicios → Credenciales**.
11. **+ Crear credenciales → ID de cliente de OAuth**.
12. Tipo de aplicación: **App de escritorio** (Desktop app) → nombre cualquiera → **Crear**.
13. Te muestra el **Client ID** y el **Client Secret** → **copiá los dos**.

## PASO 5 — Conectar en la app
14. Abrí **Calendario WoodTools → ⚙ Conexiones** → sección **▶️ YouTube**.
15. Pegá **Client ID** y **Client Secret** → clic en **"▶️ Conectar con YouTube"**.
16. Se abre una ventana de Google → iniciá sesión con la cuenta del canal → autorizá (si aparece "app no verificada", *Avanzada → continuar*).
17. Si dice **"✅ YouTube conectado. Canal: …"**, ya está.

---

## Cómo publicar
- Tarea tipo **Contenido** → tildá **YouTube** → formato **Video** o **Short**.
- **📎 Elegir archivo** → un **MP4** (los Shorts son verticales, ≤ 3 min; la app les agrega `#Shorts` solo).
- Modo **Publicar automático** → a la hora programada sube el video. O **📤 Publicar ahora**.

## Límites / notas
- Subir un video cuesta poca cuota (~100 unidades; alcanza para muchísimos videos por día).
- El título sale del **nombre de la tarea**; la descripción, del **epígrafe**.
- YouTube solo acepta **video** (no fotos).
