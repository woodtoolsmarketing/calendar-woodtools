# Calendario WoodTools

App de escritorio (Electron) para gestionar tareas y programar contenido de redes,
con notificaciones por nivel de importancia.

## Cómo se usa

```bash
npm install        # solo la primera vez
npm start          # abre la app
```

La app se queda en la **bandeja del sistema** (al lado del reloj) aunque cierres la
ventana, para poder avisarte de los recordatorios. Para salir del todo: clic derecho
en el ícono de la bandeja → *Salir*.

## Funciones

- **Vistas**: Mes, Semana, Día y Lista (estilo Google Calendar).
- **Crear tarea**: clic en un día/horario o botón *+ Nueva tarea*.
- **Niveles de importancia**:
  - 🔴 **Trascendental** (rosa rojizo): ventana emergente que salta al frente y suena, pausando tu atención. Botones *Hecha / Posponer 10 min / Cerrar*.
  - 🟢 **Importante** (verde agua): notificación nativa de Windows.
  - 🟤 **Prescindible** (marrón cobrizo): no notifica, sólo se ve dentro del programa.
- **Repetir tarea**: guardá una tarea como *plantilla* y reutilizala desde el desplegable "Repetir tarea guardada".
- **Recurrencia**: diaria, semanal o mensual.
- **Listas laterales**: Pendientes y Realizadas (próximos 30 días). Clic en una tarjeta para editar / marcar hecha / reprogramar.
- **Reprogramar**: arrastrá el evento en el calendario, o editá la fecha/hora en el formulario.
- **Contenido de redes**: tipo *Contenido* → elegí plataformas (Instagram, Facebook, Threads, TikTok, YouTube) y formato (Historia, Reel, Post, Video, Short).
- **Historia con link**: al programar un Reel o publicación, tildá "recordarme subir historia con link" y se crea un recordatorio **Trascendental** automático (lo subís vos desde tu cuenta).

## Datos

Se guardan localmente en:
`%APPDATA%\calendario-interactive\calendario-data.json`

## Empaquetar como instalador (.exe) — opcional

```bash
npm install --save-dev electron-builder
npm run dist
```

## Ícono

`assets/icon.png` (256×256). Reemplazalo por el logo de WoodTools manteniendo ese tamaño.

## Pendiente / etapa 2

- Publicación automática vía APIs oficiales (Meta / TikTok / YouTube). Requiere cuentas
  de desarrollador y aprobaciones. Hoy funciona con **recordatorios** para publicar a mano.
- Arranque automático con Windows.
- Sincronización en la nube entre varias PC.
# calendar-woodtools
