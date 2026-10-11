# Guía de instalación en Windows

Guía pensada para instalar el sistema en la PC de trabajo (no hace falta saber programar).

## Paso 1 — Instalar Node.js

1. Entrá a https://nodejs.org/es
2. Descargá la versión **LTS** (botón de la izquierda). Sirven Node **20, 22 o 24**.
3. Instalala con las opciones por defecto (Siguiente → Siguiente → Instalar).
4. Reiniciá la PC si el instalador lo pide.

> Si ya tenés otra versión de Node y al iniciar aparece un error que dice
> *"Could not locate the bindings file"*, instalá una de las versiones de arriba,
> borrá la carpeta `node_modules` y volvé a ejecutar `Instalar.bat`.

## Paso 2 — Copiar el sistema

Copiá la carpeta **"Sistema Autorizacion Personal"** completa a la PC
(por ejemplo, al Escritorio o a `C:\Sistemas\`).

## Paso 3 — Instalar la aplicación

Entrá a la carpeta y hacé **doble clic en `Instalar.bat`**.
Se va a abrir una ventana negra que:

- verifica que Node.js esté instalado,
- crea el archivo de configuración `.env`,
- instala los componentes y compila la aplicación.

Puede tardar varios minutos la primera vez. Cuando termine, dice **"INSTALACIÓN COMPLETA"**.

## Paso 4 — Iniciar

Hacé **doble clic en `Iniciar.bat`**.

- Se abre una ventana negra (es el "motor" del sistema: **no la cierres** mientras lo usás).
- A los pocos segundos se abre el navegador en `http://127.0.0.1:4000`.

La **primera vez** el sistema te pide crear el **usuario administrador**
(tu nombre, un email y una contraseña de al menos 8 caracteres). Ese usuario va a poder
crear después los usuarios de Seguridad.

## Paso 5 — Configurar el email

La casilla **no se configura desde la app**: vive en variables de entorno (`MAIL_*`). Hay una
sola y es la de la empresa (`seguridad@shopping.example`).

1. En el `.env` (o en la config del servicio) van los datos de **IMAP** (recepción) y **SMTP**
   (envío): host, puerto, usuario. Ver la tabla de variables en el README.
2. Las **contraseñas** van aparte, como secretos, nunca en el repo:
   `flyctl secrets set MAIL_IMAP_PASSWORD=... MAIL_SMTP_PASSWORD=... -a <app>`
3. `MAIL_POLL_MINUTES` es cada cuánto se revisa el buzón (0 lo desactiva).
4. Si es una casilla nueva, poné `MAIL_REVISAR_ANTES_DE` en la fecha del cambio: si no, la primera
   revisión recorre el INBOX entero y le contesta a cada correo viejo.
5. En **Administración → Monitoreo** se ve, de solo lectura, qué casilla quedó configurada, si el
   lector está corriendo, la última revisión y cuándo es la próxima.

## Paso 6 (opcional) — OCR sin Internet

Si la PC no tiene Internet permanente, ejecutá una vez (con Internet):

```
npm run ocr:download
```

Esto descarga el reconocimiento de texto en español para que funcione offline.

---

## Copias de seguridad

Hacé **doble clic en `Backup.bat`** cada tanto. Crea una copia de la base de datos y
los documentos en `storage/backups`, sin borrar las copias anteriores.

## Si olvidás la contraseña de administrador

Abrí una terminal en la carpeta del proyecto y ejecutá (reemplazá email y contraseña):

```
cd backend
npm run reset-admin -- admin@ejemplo.com NuevaClave123
```

## Cómo detener el sistema

Cerrá la ventana negra que abrió `Iniciar.bat`. El sistema deja de estar disponible
hasta que lo vuelvas a iniciar.

## Datos importantes

- La información se guarda en la carpeta **`storage`** (base de datos y documentos).
  Si querés mudar el sistema a otra PC conservando los datos, copiá también esa carpeta.
- El sistema funciona **solo en esta PC** (`127.0.0.1`); no queda expuesto a Internet.
