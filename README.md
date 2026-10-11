# Sistema de Autorización de Personal Externo

Sistema para digitalizar la gestión y autorización de ingreso de personal externo
(electricistas, técnicos, mantenimiento, proveedores, contratistas) a los locales de
un shopping. Reemplaza las carpetas físicas de documentación por un flujo digital,
con lectura automática de emails, registro de personas a partir de un Excel y
**verificación y decisión final siempre a cargo de una persona (Administración/Seguridad)**.

> Funciona en **una sola PC con Windows**, sin depender de la nube ni de servicios externos.

> **Sobre este repositorio.** Es una copia pública del sistema, que está en producción en un
> shopping. Los nombres, documentos, correos, marcas y empresas que aparecen en el código y en los
> tests fueron reemplazados por datos inventados; la configuración real no está incluida.
>
> El código fue generado con Claude Code. Mi rol fue el relevamiento con los usuarios, la definición
> funcional, la validación de cada entrega y la puesta en producción.

---

## 1. Qué es y qué hace

- Lee automáticamente el email del encargado del local (IMAP). El **asunto declara el local**
  (`Solicitud FAO (Local) …`) y un **Excel adjunto opcional** (columnas **CUIL** y **Nombre completo**)
  lista a las personas. Si el email no trae Excel, la solicitud se crea igual y las personas se
  cargan a mano desde el detalle.
- Crea **una solicitud por email**: un **local** con **una o varias personas** a autorizar.
- Cada persona tiene una **ficha con su documentación versionada** (nunca borra el original) y un
  **checklist manual**: cada requisito se aprueba (✓ Verificado) revisando la documentación del email.
- **No autoriza solo**: la verificación de cada documento y la autorización/observación/rechazo los decide un usuario.
  Solo se puede **autorizar** cuando **toda la documentación obligatoria de esa persona está verificada**.
- Autoriza **por persona** y por **rango de fechas** (uno o varios días).
- Permite registrar **ingreso y salida** reales (Administración y Seguridad), ver quién está adentro
  y consultar en segundos si una persona puede entrar.
- Guarda **auditoría** completa de todas las acciones y envía **emails automáticos** (observación, autorización, rechazo).

## 2. Arquitectura

```
Navegador (React)  ──HTTP──▶  Backend (Fastify / Node.js)
                                   │
        ┌──────────────────────────┼───────────────────────────┐
     SQLite (datos)        Almacenamiento de archivos      Lector de Email
   storage/data/sistema.db   storage/documentos/...        IMAP + cola interna
                                   │
              Asunto → Local  +  Excel adjunto (CUIL + Nombre) → Personas
```

- **Backend**: Node.js + TypeScript + Fastify. Módulos separados (auth, personas, locales, documentos, solicitudes, autorizaciones, ingresos, email, procesamiento, notificaciones, auditoría).
- **Frontend**: React + Vite (una sola página, servida por el mismo backend en producción).
- **Base de datos**: SQLite (un solo archivo, sin instalar motores).
- **Lectura de Excel** sin dependencias externas (un `.xlsx` es un ZIP con XML; se lee la primera hoja).
- La verificación de documentación es **manual** (la persona de Seguridad aprueba cada requisito). El proyecto
  conserva los módulos de OCR/reglas para posibles usos futuros, pero **no** intervienen en el flujo actual.

## 3. Requisitos

- **Windows 10 u 11**.
- **Node.js 20, 22 o 24** (LTS). Descarga: https://nodejs.org/es
  > Fuera de ese rango, `better-sqlite3` no tiene binario precompilado y npm intenta
  > compilarlo, lo que requiere Visual Studio Build Tools. Si al iniciar aparece
  > *"Could not locate the bindings file"*, es esto: instalá una de esas versiones de Node,
  > borrá `node_modules` y volvé a ejecutar `Instalar.bat`.
- ~500 MB de disco (más lo que ocupe la documentación).
- (Opcional) Conexión a Internet **solo la primera vez** para descargar los datos de OCR en español.

## 4. Instalación (rápida, para el usuario final)

1. Copiá la carpeta del proyecto a la PC.
2. Doble clic en **`Instalar.bat`** (instala dependencias y compila).
3. Doble clic en **`Iniciar.bat`** (abre el navegador en `http://127.0.0.1:4000`).
4. La primera vez, el sistema te guía para **crear el usuario administrador**.

Ver el paso a paso detallado en [`docs/INSTALACION.md`](docs/INSTALACION.md).

## 5. Instalación (para desarrollo)

```bash
npm install
copy .env.example .env      # y completar valores
npm run build               # compila frontend + backend
npm start                   # inicia en http://127.0.0.1:4000
```

Modo desarrollo (con recarga):

```bash
npm run dev          # backend en :4000
npm run dev:front    # frontend en :5173 (proxy a :4000)
```

## 6. Configuración (variables de entorno)

Toda la configuración vive en `.env` (nunca se sube al repositorio). Ver `.env.example`.
Lo más importante:

| Variable | Descripción |
|---|---|
| `PORT` / `HOST` | Puerto y host del servidor (por defecto `4000` / `127.0.0.1`). |
| `SESSION_SECRET` | Secreto para firmar sesiones y cifrar credenciales guardadas. **Cambialo.** |
| `STORAGE_PATH` | Carpeta de datos y documentos (por defecto `./storage`). |
| `TZ` | Zona horaria (`America/Argentina/Buenos_Aires`). |
| `MAIL_IMAP_*` / `MAIL_SMTP_*` | Credenciales de la casilla del sistema. **Única fuente**: no se editan desde la app. |
| `MAIL_POLL_MINUTES` | Frecuencia de revisión del buzón (0 = desactivado). Valor inicial; después manda lo guardado en la app. |
| `MAIL_REVISAR_ANTES_DE` | `YYYY-MM-DD`: los correos anteriores a esa fecha van al **respaldo** en vez de procesarse solos. Vacío = todo se procesa. |
| `EXPIRY_ALERT_DAYS` | Días de anticipación para avisar vencimientos. |
| `MAX_FILE_MB` / `MAX_ZIP_UNCOMPRESSED_MB` | Límites de tamaño (protección anti ZIP-bomb). |

### La casilla del sistema

Hay **una sola casilla** y es la de la empresa:

| | IMAP (recepción) | SMTP (envío) |
|---|---|---|
| Servidor | `mail.shopping.example` | `mail.shopping.example` |
| Puerto | `993` | `587` |
| Seguridad | SSL/TLS **sí** | SSL **no** (usa STARTTLS) |
| Usuario | `seguridad@shopping.example` | la misma dirección |

**La configuración vive solo en el entorno** (variables `MAIL_*`), no en la base ni en el panel.
Antes se editaba desde Administración y eso fue justamente lo que rompió la recepción: quedó una
casilla cargada sin contraseña y otra apuntando a una cuenta bloqueada, y el sistema dejó de leer
el buzón durante días sin que nadie lo notara. En **Administración → Monitoreo** se ve, de solo
lectura, qué casilla está configurada, si el lector está corriendo, la última revisión y la próxima.

Para cambiar la contraseña no hace falta desplegar:

```bash
flyctl secrets set MAIL_IMAP_PASSWORD=... MAIL_SMTP_PASSWORD=... -a <app>
```

(guardar un secreto reinicia la máquina y toma el valor nuevo).

> **Al apuntar el sistema a una casilla nueva**, poné `MAIL_REVISAR_ANTES_DE` en la fecha del
> cambio. Sin eso, la primera revisión recorre el INBOX entero de la casilla nueva y le contesta
> "falta la lista de personal" a cada correo viejo.

#### El mismo pedido dos veces

Un pedido que llega dos veces **no genera dos solicitudes**:

- Si es **un solo correo** con varias direcciones en el "Para", las copias traen el mismo
  `Message-ID` y la segunda ni se ingresa.
- Si son **dos correos separados** (dos personas del local mandan lo mismo), se comparan por una
  **huella de contenido** (remitente + asunto sin el `Re:`/`RV:` + SHA-256 de los adjuntos). Si
  coinciden dentro de los 7 días, el segundo se engancha al pedido original. Dos pedidos distintos
  del mismo local con el mismo asunto siguen entrando por separado, porque los adjuntos difieren.

### Locales

Los locales no hace falta cargarlos de antemano: se crean solos cuando aparece uno nuevo.

- **Desde un email**: el nombre sale del asunto (`Solicitud FAO (Local) …`). Se busca entre los
  cargados con match aproximado (ignora mayúsculas y acentos, y acepta que el nombre venga con
  texto alrededor); si no hay coincidencia, se crea.
- **A mano**: en **Solicitudes → + Nueva solicitud** el campo *Local* se escribe libremente y
  sugiere los ya cargados. Si escribís uno que no existe, se crea junto con la solicitud. La
  comparación ignora mayúsculas, acentos y espacios de más, así que "pizza hut" reusa "Pizza Sur".

Se pueden editar (nombre, email, estado) desde **Administración → Locales**.

## 7. Base de datos

- Motor: **SQLite** (archivo `storage/data/sistema.db`).
- El esquema se crea/actualiza solo al iniciar (`CREATE TABLE IF NOT EXISTS`, idempotente).
- Entidades principales: `users`, `locales`, `personas` (identificadas por **CUIL**), `document_types`,
  `documentos`, `document_versions`, `email_messages`, `processing_jobs`, `solicitudes`
  (con el **número de orden** de la revisión),
  `solicitud_personas` (las **varias personas** de una solicitud), `autorizaciones`, `entradas`,
  `comentarios`, `audit_log`, `settings`.

Comandos:

```bash
npm run migrate    # crea el esquema y los tipos de documento obligatorios
npm run seed       # carga datos de DEMOSTRACIÓN (usuarios, locales, personas)
```

## 8. Email (protocolo)

- **Recepción (IMAP)**: revisa el buzón cada `MAIL_POLL_MINUTES` minutos. No borra los emails;
  opcionalmente puede moverlos a una carpeta "Procesados". Es **idempotente**: no procesa dos veces
  el mismo mensaje (se identifica por `Message-ID`; si el correo no trae ese header, se le calcula
  una huella estable con fecha + remitente + asunto, así no se pierde). Cada mensaje se ingresa
  por separado: si uno falla, los que vienen atrás se procesan igual. También revisa la carpeta de
  **spam**, pero esos quedan en el respaldo sin procesar.
- **Asunto → Local + Tipo**: el asunto debe empezar con `Solicitud FAO`, seguido del **nombre del local**
  y del **tipo de contratista** (`Empresa` o `Monotributista`).
  El nombre del local se toma, en este orden: **entre paréntesis** → **entre guiones** → **tercera palabra**.
  Ejemplos válidos:
  - `Solicitud FAO (Burger Sur) Empresa`
  - `Solicitud FAO - Mostaza - Monotributista`
  - `Solicitud FAO Deportes Empresa`

  > Si el nombre del local tiene **varias palabras**, ponelo **entre paréntesis** o **entre guiones**
  > para que el sistema no lo corte. Si no coincide con un local cargado, la solicitud queda
  > **"Sin asignar"** y el Administrador lo asigna desde el detalle. El tipo define qué documentación
  > se le exige a cada persona (ver sección 9).
- **Excel de personas (opcional)**: si el email trae **un Excel adjunto** con las columnas **CUIL** y
  **Nombre completo** (formato *Nombre Apellido*), el sistema detecta esas columnas por su encabezado;
  si no hay encabezados, usa la **columna A = CUIL** y **columna B = Nombre**. Con cada fila crea/asocia
  a la persona (por CUIL, sin duplicar) dentro de la solicitud.
  **Si no se puede leer la lista de personas** no se crea la solicitud —aunque el correo traiga
  toda la documentación adjunta—: se le pide la lista al remitente y el correo queda en el
  **respaldo**. La idea es que reenvíe el pedido completo y entre solo; dar de alta la solicitud
  vacía y cargar las personas a mano no escala. Desde el respaldo el admin lo resuelve con
  **"Procesar"** (lo da de alta como el sistema lo interpreta), **"Es otro pedido"** (le impone
  abrir una solicitud aparte) o **"Descartar"**.
- **Reenvíos**: si el local reenvía documentación corregida (email nuevo con los mismos CUIL de una
  solicitud abierta del mismo local), la solicitud **anterior queda "Reemplazada"** y la nueva pasa a
  **Pendiente** para re-revisar. No se duplica.
- **Envío (SMTP)**: avisos automáticos de observación, autorización y rechazo.
- Las contraseñas de la casilla van como **secretos de fly**, nunca en el repo ni en la base.

## 9. Documentación por tipo de contratista (aprobación manual)

Según el tipo declarado en el asunto, a cada persona se le exige:

| Empresa | Monotributista |
|---|---|
| Formulario 931 | Seguro de Vida Colectivo (mín. $20.337.714) |
| Pago de ARCA | Pago del Monotributo |
| Nómina ART | — |
| Cláusula de No Repetición (a favor de Cencosud SA) | Cláusula de No Repetición (a favor de Cencosud SA) |

- La documentación llega **adjunta al email** y se ve **embebida** dentro de la solicitud.
- Para cada persona hay un **checklist**; Seguridad revisa y marca cada requisito como **✓ Aprobar**
  o **✕ Falta / Rechazar**. No hay detección automática: un requisito solo cuenta como cumplido al aprobarlo.
- **Vencimiento**: al aprobar un documento se puede cargar una **fecha de vencimiento**. Al llegar esa
  fecha el documento deja de valer, la persona **no puede ingresar** hasta renovarlo, y aparece en el
  panel (contador *Vencimientos*) y en **Reportes → Vencimientos**.
- Solo se puede **autorizar** a una persona cuando **todos sus requisitos obligatorios están aprobados y vigentes**.

### Número de orden

Al tocar **Terminar revisión**, la solicitud recibe un **número de orden** con formato
`OA-AAAA-NNNN` (por ejemplo `OA-2026-0001`), con secuencia propia por año.

- Se genera **una sola vez**: si se reenvía el email de resultado, el número no cambia.
- Todas las solicitudes del **mismo email** comparten el número, porque el remitente recibe
  una sola respuesta por su correo.
- Va en el **asunto** y en el **cuerpo** del email de resultado, para que el local pueda citarlo.
- Se muestra en el detalle de la solicitud y en la columna *Orden* del listado, y el buscador
  encuentra por número.
- Se asigna aunque el email no se pueda enviar (SMTP mal configurado, remitente sin dirección):
  la revisión queda identificada igual.

> La sigla se cambia en `PREFIJO_ORDEN`, en `backend/src/modules/solicitudes/service.ts`.

## 10. Ejecución

```bash
npm start                 # producción (sirve el frontend compilado)
```
Luego abrir `http://127.0.0.1:4000`.

## 11. Tests

```bash
npm test
```
Cubren seguridad de archivos (ZIP Slip, extensiones), lectura del Excel de personas,
no-duplicación de personas por **CUIL**, ingesta de correos (un pedido sin lista de personas no
crea solicitud ni siquiera con documentación adjunta, pero "Procesar igual" sí, tomando el local
del asunto; el mismo pedido que llega dos veces se engancha al original en vez de
duplicarse; (un pedido con documentación pero sin
lista de personas crea la solicitud igual; uno sin adjuntos no; huella estable para los correos sin
`Message-ID`), verificación manual de documentación (un requisito solo
cuenta como cumplido al verificarlo), versionado de documentos, solicitudes creadas sin personas
(email sin Excel), generación del **número de orden** (correlativo por año, idempotente y
compartido por el grupo del email) y vigencia de autorizaciones por **rango de fechas**.

## 12. Backups

```bash
npm run backup        # o doble clic en Backup.bat
```
Copia la base de datos y la documentación a `storage/backups/backup_<fecha>` sin sobrescribir
backups anteriores.

## 13. Restauración

1. Detener el sistema (cerrar la ventana de `Iniciar.bat`).
2. Reemplazar el contenido de `storage/data` y `storage/documentos` por el del backup deseado.
3. Volver a iniciar.

## 14. Instalación en otra PC (Windows)

1. Copiar toda la carpeta del proyecto (sin `node_modules` ni `storage` si querés empezar limpio).
2. Instalar **Node.js LTS** en la PC destino.
3. Ejecutar `Instalar.bat` y luego `Iniciar.bat`.

> **Nota OneDrive**: si la carpeta está dentro de OneDrive, conviene excluir `node_modules` y
> `storage` de la sincronización para evitar lentitud.

## 15. Solución de problemas (Troubleshooting)

| Problema | Solución |
|---|---|
| "No se encontró Node.js" | Instalar Node.js LTS desde nodejs.org y reabrir `Instalar.bat`. |
| "Could not locate the bindings file" | La versión de Node no es compatible con `better-sqlite3`. Instalá Node **20, 22 o 24**, borrá `node_modules` y volvé a correr `Instalar.bat`. |
| El puerto 4000 está ocupado | Cambiar `PORT` en `.env`. |
| No lee emails | Revisar credenciales IMAP y usar contraseña de aplicación; probar conexión desde la app. |
| Se conectó una casilla nueva y no lee los correos viejos | Es a propósito: mirá *Ignorar correos anteriores a* en la configuración de email. Vaciá el campo para leer todo el buzón. |
| El email quedó en ERROR | No se pudo leer el email guardado o falló el procesamiento. Ver el detalle en Monitoreo. |
| La solicitud quedó sin personas | El email no traía Excel (o no se pudo leer). Cargalas a mano desde el detalle de la solicitud. |
| Un pedido con documentación no generó solicitud | Es a propósito: sin lista de CUIL legible se le pide al remitente que la reenvíe. Está en **Respaldo**, con botones para responderle o para forzar el alta. |
| No revisa el buzón solo | Verificá en **Monitoreo** que el lector figure activo y con próxima revisión. Si dice "no está corriendo", falta el servidor IMAP o la frecuencia está en 0. |
| La solicitud quedó "Sin asignar" | El local del asunto no coincide con uno cargado. Asignalo desde el detalle de la solicitud. |
| Olvidé la contraseña de admin | Ver `docs/INSTALACION.md` (restablecer usuario). |

---

## Roles

- **Administrador**: gestiona usuarios, locales, tipos de documento, email, monitoreo, auditoría y backups;
  verifica documentación, autoriza / observa / rechaza / revoca, registra ingresos y salidas.
- **Seguridad**: consulta personas, verifica documentación, autoriza / observa / rechaza / revoca, registra ingresos y salidas.

## Seguridad

Autenticación por sesión (cookie httpOnly), contraseñas con **bcrypt**, credenciales de email
**cifradas** (AES-256-GCM), validación de entradas (Zod), protección contra **Zip Slip / path traversal**,
documentos servidos **solo** por rutas autenticadas (nunca por URL pública), y **auditoría** de todas las
acciones relevantes.

## Datos de demostración

Tras `npm run seed`:

- **admin@shopping.local** / `Admin1234` (Administrador)
- **seguridad@shopping.local** / `Seguridad1234` (Seguridad)

> Datos ficticios. No usar documentación ni CUIL reales en pruebas.
