# Guía: conectar YouTube

Necesitás 2 datos (**Client ID** y **Client Secret**) de un proyecto de Google Cloud. Se hace **una
sola vez**. Después, en la app tocás **Conectar** e iniciás sesión en tu navegador.

El video se sube **directo desde tu PC** (no usa Cloudinary).

> **Importante:** para que los videos salgan **públicos** hace falta la **auditoría de la API de
> YouTube**, y para que la conexión no se corte cada 7 días hay que **publicar la app de Google**.
> Los dos pasos, con respuestas listas para pegar, están en la sección 5 de
> [GUIA-CONEXIONES-DEFINITIVAS.md](GUIA-CONEXIONES-DEFINITIVAS.md).

---

## PASO 1: crear el proyecto

1. Entrá a https://console.cloud.google.com/ con la cuenta de Google del canal de WoodTools.
2. Selector de proyectos → **Proyecto nuevo** → nombre: *Calendario WoodTools* → **Crear**.
3. Dejalo **seleccionado** arriba. Usá **un solo proyecto** para esta app (Google no permite repartirla en varios).

## PASO 2: activar la API de YouTube

4. Menú ☰ → **APIs y servicios → Biblioteca**.
5. Buscá **YouTube Data API v3** → **Habilitar**.

## PASO 3: Google Auth Platform (pantalla de consentimiento)

6. Menú ☰ → **Google Auth Platform** → **Comenzar**.
7. **Información de la app:** nombre *Calendario WoodTools* y correo de asistencia de la empresa.
   **No subas logo** (con logo, Google exige verificar la app).
8. **Público:** **Externo**.
9. **Contacto:** el mail de la empresa → **Crear**.
10. **Público → Estado de publicación → Publicar app → Confirmar**. Tiene que quedar **En producción**.
    En modo *Prueba*, Google corta la conexión **a los 7 días**.
11. (Recomendado) **Acceso a datos → Agregar o quitar permisos:** `youtube.upload` y `youtube.readonly` → **Guardar**.

## PASO 4: crear el cliente (Client ID + Secret)

12. **Google Auth Platform → Clientes → Crear cliente**.
13. Tipo de aplicación: **App de escritorio** → nombre *Calendario WoodTools* → **Crear**.
14. En la ventana que aparece, tocá **Descargar JSON** y guardalo en un lugar seguro: Google puede
    mostrar la clave **una sola vez**. Copiá el **Client ID** y el **Client Secret**.

## PASO 5: conectar en la app

15. Calendario WoodTools → **⚙ Conexiones → YouTube** → pegá el **Client ID** en *ID de cliente* y el
    **Client Secret** en *Secreto del cliente* → **Guardar**.
16. Tocá **Conectar**. Se abre **tu navegador** (Chrome, Edge, etc.):
    1. Elegí la cuenta o el canal de marca de WoodTools.
    2. Si aparece *"Google no verificó esta app"*: **Configuración avanzada** → **Ir a Calendario
       WoodTools (no seguro)**. Es normal: la app es de ustedes.
    3. **Tildá los dos permisos** → **Continuar**.
    4. Cuando el navegador diga que podés cerrar la pestaña, volvé a la app.
17. El estado muestra el **nombre del canal**.

## PASO 6: verificar el canal por teléfono

18. https://www.youtube.com/verify → código por SMS o llamada. Sin esto no se pueden poner
    **miniaturas personalizadas** ni subir videos de **más de 15 minutos**.

## PASO 7: auditoría (videos públicos)

19. Mandá el formulario de auditoría (sección 5.3 de la guía maestra). Hasta que lo aprueben, **todo
    video subido por la app queda privado** y la app te lo recuerda con un aviso.
20. Cuando lo aprueben: **⚙ Conexiones → YouTube** → tildá **Google aprobó la auditoría de la API de
    YouTube** → **Guardar**.

---

## Cómo publicar

- Tarea de Tipo **Contenido de redes** → tildá **YouTube** → formato **Video (YouTube)** o
  **Short (YouTube)** → **Publicar automático** → **📎 Elegir archivo** (MP4).
- **Título de YouTube:** hasta 100 caracteres, sin `<` ni `>`. **Descripción:** hasta 5.000 bytes.
- **Visibilidad:** Público (por defecto), No listado o Privado. Se ve antes de confirmar.
- **La app no cambia tus textos.** `#Shorts` se agrega **solo si tildás «Agregar #Shorts a la descripción»**.
  YouTube clasifica un video como Short por sí solo si es **vertical o cuadrado** y dura **hasta 3 minutos**.
- **Miniatura:** imagen JPG o PNG (canal verificado, Paso 6).
- Modo **Publicar automático** → sube el video a la hora programada (la PC tiene que estar prendida).
  O **📤 Publicar ahora**.

## Límites y notas

- **Cuota:** hasta **100 subidas por día** (cuota propia de subidas); poner una miniatura gasta unas
  50 de las 10.000 unidades diarias. Sobra para un canal.
- YouTube también tiene un **límite diario por canal** que no publica; si aparece, reintentá al día siguiente.
- YouTube solo acepta **video** (no fotos).
- La conexión dura para siempre si: la app de Google está **En producción**, no borrás ni regenerás la
  clave del cliente y la app se usa al menos una vez cada 6 meses (renueva sola cada día que la PC está prendida).

## Si algo falla

- **"Google revocó o venció el acceso de YouTube. Reconectá YouTube.":** tocá **Conectar** otra vez.
  Si pasa cada 7 días, la app de Google sigue en *Prueba* (Paso 3, punto 10).
- **Falta el permiso de subir videos:** reconectá y **tildá los dos permisos** en la pantalla de Google.
- **El video quedó privado:** falta la auditoría (Paso 7).
- **No se puso la miniatura:** verificá el canal (Paso 6).
- **El navegador no vuelve a la app:** tenés 5 minutos para autorizar; cerrá la pestaña y tocá
  **Conectar** de nuevo.
