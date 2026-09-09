# Gateway de acciones seguras para el agente bancario (card-block-gateway)

Un servidor MCP deja que el agente bancario de AI Findr **proponga** el bloqueo de una tarjeta de
débito. Nunca lo ejecuta. Un sistema de banca simulado, independiente, deja que un **humano
autenticado** revise esa propuesta y la confirme. Solo entonces se ejecuta, de forma simulada.

La tesis del diseño, y lo único que de verdad importa evaluar aquí: **el agente es un llamante no
confiable**. El sistema tiene que seguir siendo seguro incluso si el agente está completamente
comprometido por inyección de prompt — no "más difícil de comprometer", sino estructuralmente
incapaz de ejecutar nada por sí solo.

---

## 1. Arquitectura: dos canales, y por qué están separados

```
Agente AI Findr ──MCP / HTTPS (OAuth 2.1: access token)──┐
                                                          ├──> Node (Express) ──> SQLite
Humano ──navegador (cookie firmada, login propio)────────┘
```

Un único proceso Node monta tres superficies sobre el mismo Express:

- `POST /mcp` — transporte MCP (Streamable HTTP), lo habla el agente.
- `/api/*` — REST para la SPA, lo habla el navegador del titular.
- `/` — estáticos del build de Vite (la SPA de banca).

Son **dos canales de entrada con dos anclas de confianza distintas**, y esa separación es el
corazón del diseño, no un detalle de implementación:

- El **canal del agente** (`/mcp`) se identifica por el access token OAuth 2.1 que trae la
  petición HTTP, verificado por `requireBearerAuth` antes de que ninguna tool se ejecute (§3 más
  abajo). El agente **no recibe ni transporta esa identidad en su contexto** — no hay ningún
  `session_token` ni campo equivalente en las tools (`src/mcp/tools.ts`) — y ese token **solo
  permite proponer**: no existe ninguna operación en este canal que confirme o ejecute nada (§2 más
  abajo).
- El **canal humano** (`/api/*` + SPA) exige una cookie de sesión firmada por el servidor, obtenida
  con un login independiente. Solo desde ese canal se puede confirmar o rechazar una propuesta.

**Por qué separarlos:** un prompt injection puede controlar completamente lo que el agente dice y
hace dentro de su propio canal — puede mentir sobre quién es el usuario, inventarse que ya confirmó,
o intentar invocar una tool que no existe. Nada de eso importa si el canal que puede *ejecutar* es
un canal distinto, con una credencial distinta, que el agente nunca tiene en sus manos. Y a
diferencia de una credencial que viaja en el contenido de la conversación, el access token OAuth del
agente **no es algo que una inyección de prompt pueda leer y exfiltrar**: no está en ningún mensaje
que el agente vea, así que no puede exfiltrar lo que no tiene. Con todo, ese token sigue sin
servir para nada más que crear propuestas inertes, por si el propio AI Findr como plataforma
estuviera comprometido. La cookie web nunca viaja por el contexto del agente. Confirmar exige además
que la propuesta pertenezca al cliente autenticado en esa cookie.

El módulo `src/domain/` es puro (sin HTTP, sin MCP, sin SQL): la máquina de estados y sus reglas se
pueden testear y razonar sin levantar ningún servidor.

## 2. Las tres decisiones de seguridad

**C1 — El agente no elige el objetivo (referencias opacas por sesión).**
El agente nunca recibe ni envía un PAN ni un id interno de tarjeta. `list_debit_cards` devuelve un
`card_ref` opaco (`cref_...`) generado y almacenado por sesión (`card_refs`, ver `src/db/schema.sql`).
Una sesión es el access token OAuth de la conexión (`session_key` = hash del token, calculado en
`verifyAccessToken`, ver §3): no una fila que este servidor cree ni un identificador que el agente
elija o reciba. `propose_card_block` solo acepta esos refs, y solo resuelven dentro de la sesión que
los generó. Un `card_ref` inventado, adivinado o copiado de otra sesión no resuelve — y el error que
se devuelve es *no encontrado*, nunca *prohibido*: distinguirlos permitiría a un agente inyectado
enumerar qué tarjetas existen fuera de su sesión por ensayo y error.

**C2 — Ausencia de tool de confirmación o ejecución.**
La superficie MCP tiene exactamente tres tools: `list_debit_cards`, `propose_card_block`,
`get_proposal_status` (`src/mcp/tools.ts`). Ninguna confirma, aprueba ni ejecuta. No es una omisión
temporal: es la propiedad central del diseño, y hay un test estructural
(`tests/mcp/tools.test.ts`) que falla si alguien añade una tool con un nombre que sugiera
confirmación o ejecución. Un prompt de inyección puede pedirle al agente que "use la tool
`confirm_card_block`" — no existe, así que la única salida es que el agente lo intente y falle, o
que alucine una respuesta sin que nada cambie en el servidor.

**C3 — Validación determinista en el servidor.**
La máquina de estados (`PROPOSED → CONFIRMED → EXECUTING → EXECUTED | FAILED`, más `REJECTED` y
`EXPIRED` por TTL) vive enteramente en `src/domain/proposals.ts` y se aplica en
`src/services/cardBlockService.ts`. El agente no valida nada, y no hace falta que "se comporte
bien": proponer sobre una tarjeta no `ACTIVE` se rechaza en el acto con el estado real; confirmar
una propuesta caducada, ya resuelta o de otro cliente falla; doble confirmación ejecuta una sola vez
(idempotente); proponer lo mismo dos veces dentro del TTL devuelve la propuesta existente en vez de
crear una nueva (`idempotency_key` = hash de `session_key + card_id + action + reason`, donde
`session_key` es el hash del access token — ver §3).

**Nota relacionada — el `note` del agente no se renderiza en la pantalla de confirmación.**
`propose_card_block` acepta una `note` de texto libre que viaja del agente al servidor y de ahí a la
SPA (`GET /api/proposals`), pero la pantalla de aprobación (`web/src/pages/Inbox.tsx`) no la
muestra. Es deliberado, no un olvido: mostrar texto escrito por un llamante no confiable en la única
pantalla donde un humano decide si confirma sería un canal de inyección directo hacia esa decisión
— el mismo tipo de riesgo que C1–C3 cierran del lado del agente, pero del lado del humano. Ver el
comentario en el propio componente.

## 3. Ancla de confianza — identidad por OAuth, no por contenido

Hay **una sola credencial** para el canal del agente, y el agente no la lleva encima:

| Credencial                                                           | Autentica a                                          | Alcance           |
| -------------------------------------------------------------------- | ---------------------------------------------------- | ----------------- |
| Access token OAuth 2.1 (bearer HTTP, emitido por este mismo gateway) | Un cliente de banca concreto, verificado en el login | Solo **proponer** |

No hay un segundo bearer estático para "AI Findr como servicio": AI Findr se registra dinámicamente
contra `/register` (sin URL de redirección ni credencial que pre-configurar a mano) y obtiene su
access token a través del flujo estándar `/authorize` → login + consentimiento → `/token`. Ese
access token es lo único que autentica la conexión MCP, y es lo que identifica al cliente de banca
en cada llamada — no un campo en el prompt del agente.

**Cómo llega la identidad a cada tool, exactamente:**

1. `requireBearerAuth` (SDK de MCP, montado en `src/mcp/server.ts`) valida el bearer de la petición
   HTTP con `verifyAccessToken` (`src/oauth/provider.ts`) antes de que la petición llegue a
   `/mcp`. Un token inexistente, revocado, caducado o sin el scope `cards:propose` se rechaza con
   401, sin ejecutar nada.
2. `verifyAccessToken` devuelve `customerId` (el cliente de banca dueño del token) y `sessionKey`
   (el hash del propio access token — sustituye a lo que antes era una fila en una tabla de
   sesiones que este servidor emitía). El SDK cuelga ese resultado del contexto de cada tool call
   (`extra.authInfo`).
3. `buildMcpServer` (`src/mcp/server.ts`) lee `extra.authInfo` y construye la identidad con la que
   se invoca el handler de la tool. **Si falta `authInfo`, o le falta `customerId` o `sessionKey`,
   la llamada falla ahí mismo — nunca se ejecuta ningún handler con una identidad ausente o por
   defecto.** Es la propiedad que hace el diseño anterior obsoleto, no solo distinto: antes el
   `session_token` vivía en el contenido de la conversación, así que una inyección con capacidad de
   leer ese contenido podía exfiltrarlo; ahora el agente **no recibe esa identidad en ningún
   momento** — no puede exfiltrar lo que no tiene.

**C1 no cambia de forma, solo de qué es una "sesión":** las referencias opacas (`card_refs`, §2)
siguen acotadas a una sesión y solo resuelven dentro de ella; antes esa sesión era una fila que este
servidor creaba con `createAgentSession`, ahora es el propio access token (`session_key` = hash del
token). Un access token de otro cliente, o un token inventado, no resuelve las referencias de otro —
verificado en `tests/services/cardBlockService.test.ts` y de punta a punta con tokens OAuth reales
en `tests/oauth/flow.test.ts`.

**Supuesto explícito que sigue en pie:** la identidad es tan fuerte como el login que la establece.
En esta demo, el login que precede a la pantalla de consentimiento OAuth es simulado (selección de
cliente por botón, sin proveedor de identidad real, ver §7) — OAuth 2.1 asegura que la identidad
resuelta es la de *quien inició sesión en ese login*, no que ese login sea él mismo fuerte. Sustituir
el login simulado por uno real no requeriría tocar nada de lo descrito arriba.

## 4. Instalar, configurar, ejecutar y probar

Todo lo que sigue se ha ejecutado y verificado tal cual está escrito, con Node v24 (compatible con
el mínimo declarado, `>=22`, en `package.json`).

### 4.1 Instalar

```bash
pnpm install
```

### 4.2 Configurar

```bash
cp .env.example .env
```

Rellena `SESSION_COOKIE_SECRET` con cualquier cadena aleatoria propia (por ejemplo
`openssl rand -hex 32`), no versionada. El resto de valores por defecto sirven para local. `.env`
está en `.gitignore` y así debe seguir — nunca metas credenciales reales en el repositorio. No hay
ningún bearer estático del canal MCP que configurar aquí (§3): el access token de AI Findr lo emite
este mismo servidor a través del flujo OAuth.

`pnpm run dev` y `pnpm start` cargan `.env` automáticamente con el flag nativo de Node
[`--env-file`](https://nodejs.org/api/cli.html#--env-fileconfig) (soportado desde Node 20.6, y
Node 22+ lo trae sin flag experimental). Se verificó explícitamente que `--env-file` se propaga a
través de `tsx watch` — no todos los flags de Node lo hacen, pero este sí — así que no hizo falta
añadir la dependencia `dotenv`. Ver §9 para el detalle de qué se probó.

### 4.3 Ejecutar en desarrollo

Backend (API + MCP + auditoría), en una terminal:

```bash
pnpm run dev
```

Arranca en `http://localhost:3000`. En un checkout limpio el directorio `data/` todavía no existe
(está en `.gitignore`, no se versiona): `openDatabase` (`src/db/connection.ts`) lo crea él mismo,
de forma recursiva, antes de abrir la base de datos — no hace falta crearlo a mano ni añadir un
`.gitkeep`. Crea `data/gateway.db` si no existe y la siembra con dos clientes de prueba (`cus_ana`,
`cus_luis`) y sus tarjetas — entre ellas una marcada `is_flaky` (Mastercard `****9013` de
`cus_ana`) que falla deliberadamente al ejecutar, para poder demostrar el camino
`EXECUTING → FAILED`. Verificado explícitamente arrancando desde un checkout sin `data/`: el
servidor la crea sola y responde en `:3000`.

Frontend (SPA de banca), en otra terminal:

```bash
npx vite web
```

Arranca en `http://localhost:5173` y hace proxy de `/api/*` a `http://localhost:3000` (configurado en
`web/vite.config.ts`). Abre esa URL, elige un cliente en el login simulado y usa las pestañas
*Confirmaciones*, *Mis tarjetas* y *Auditoría*.

> Nota de verificación: el comando `npx vite dev web` que aparece en el brief original no existe en
> esta versión de Vite (5.4.21) — su CLI no tiene subcomando `dev`; el comando correcto, probado, es
> `npx vite web` (o `npx vite web --port <otro>` si el 5173 está ocupado).

### 4.4 Compilar y ejecutar en modo producción

```bash
pnpm run build 
pnpm start
```

### 4.5 Tests unitarios

```bash
npx vitest run
```

## 6. Integración en vivo — pasos que faltan, para quien evalúe esto

Esta entrega **no** incluye la demostración contra el agente real ni la evidencia de inyección
generada: requiere exponer una máquina a internet y dar de alta el MCP en un proyecto de AI Findr,
dos cosas que no corresponde hacer desde este entorno sin supervisión directa de quien va a evaluar
la prueba. Lo que sigue son los pasos exactos para completarlo:

**a) Túnel HTTPS.**

```bash
pnpm run build
# en otra terminal
NGROK_AUTHTOKEN=NGROK_TOKEN pnpm start
```

Copia la URL pública que imprime `ngrok` a `PUBLIC_BASE_URL` en `.env` y reinicia el
servidor — si no, la `confirmation_url` que ve el agente apunta a `localhost` y no es alcanzable
desde la bandeja del titular real ni útil para nadie fuera de esta máquina.

**b) Alta del MCP en el proyecto Bank Assistant de AI Findr.**

AI Findr se conecta por OAuth 2.1.

- URL del MCP: `https://<túnel>/mcp`
- AI Findr descubre `https://<túnel>/.well-known/oauth-authorization-server`, se registra
  dinámicamente contra `/register` (aporta su propia redirect URI, no hace falta pre-registrar
  nada) y sigue el flujo estándar: `/authorize` → login simulado (elige `cus_ana` o `cus_luis`) +
  pantalla de consentimiento → `/token`. El resultado es un access token concreto de ESE cliente.
- `allowedTools`: `list_debit_cards`, `propose_card_block`, `get_proposal_status`

Restringir `allowedTools` explícitamente es defensa en profundidad: el servidor ya no expone
ninguna tool de confirmación (§2, C2), pero la lista documenta la intención y protege de un
despliegue futuro que añadiera una por descuido.

**c) Demostrar el happy path.**

1. Completar el flujo OAuth del paso (b) una vez, eligiendo `cus_ana` en la pantalla de
   consentimiento. No hay ningún token que copiar al prompt del agente ni variable de sistema que
   configurar en el proyecto de AI Findr — la identidad ya quedó fijada en el access token que AI
   Findr obtuvo, y las tools no reciben ni necesitan nada más (§3).
2. Pedirle al agente algo como *"Creo que me han clonado la tarjeta, bloquéala"*.
3. El agente llama a `list_debit_cards` y luego a `propose_card_block`.
4. Abrir la bandeja en la web, confirmar, observar `EXECUTING → EXECUTED`.
5. Comprobar en *Auditoría* que aparecen los cuatro eventos en orden
   (`proposal.created`, `proposal.confirmed`, `execution.started`, `execution.succeeded`).

## 7. Riesgos y limitaciones conocidos

- **No hay manejador de errores global en Express.** Un fallo inesperado (por ejemplo, una excepción
  no capturada en una ruta) cae al manejador por defecto de Express, que fuera de `NODE_ENV=production`
  incluye la traza en la respuesta HTTP. Aceptable para esta prueba; no lo sería para producción.
- **La cookie de sesión web no lleva `secure: true`** (`src/api/routes.ts`, `res.cookie(...)`).
  Imprescindible añadirlo en producción, donde el servicio corre detrás de HTTPS real y no de un
  túnel de desarrollo.
- **La clave de idempotencia es por sesión, no por tarjeta** (`hash(session_key, card_id, action,
  reason)`, donde `session_key` es el hash del access token OAuth — §3). Dos sesiones distintas del
  mismo cliente (dos access tokens, por ejemplo tras revocar y volver a autorizar) pueden crear dos
  propuestas independientes para la misma tarjeta. Con `card.block` es inocuo, porque bloquear
  es idempotente en efecto — la segunda confirmación no cambia nada que la primera no hubiera hecho
  ya. Con una acción como desbloquear o transferir, la misma decisión de diseño dejaría de ser
  inocua y habría que subir la clave de idempotencia a nivel de tarjeta.
- **El login es simulado, sin identidad real** (selección de cliente por botón, sin contraseña ni
  proveedor de identidad). Es el login que precede al consentimiento OAuth (§3): la identidad
  resultante es tan fuerte como ese login, no más.
- **La ejecución del bloqueo es simulada**: cambia
  el estado en SQLite y no toca ningún sistema externo ni emisor de tarjetas real.

## 8. Estructura del proyecto

```
src/
  domain/     # tarjetas, propuestas, máquina de estados, auditoría — puro, sin HTTP ni SQL
  db/         # esquema SQLite, semillas, repositorios
  services/   # cardBlockService: aplica la máquina de estados — toda la lógica de seguridad vive aquí
  oauth/      # OAuthServerProvider propio (SQLite) + pantalla de consentimiento — identidad de /mcp
  mcp/        # servidor MCP: resuelve la identidad del access token y define las tres tools
  api/        # rutas REST para la SPA
  server.ts   # monta /mcp, /api, el router OAuth y los estáticos del build de Vite
web/          # SPA Vite + React + TS: login, tarjetas, bandeja de confirmación, auditoría
tests/        # Vitest — dominio, repositorios, servicio, OAuth, tools MCP, rutas API
scripts/      # verifyOAuth.ts para verificar la conexión OAuth
docs/         # spec de diseño, plan de implementación, evidencia (cuando exista)
```

## 10.b Modo demostración (`DEMO_MODE`)

Con `DEMO_MODE=true` en el `.env`, la pantalla *Mis tarjetas* muestra un botón para restablecer
una tarjeta bloqueada a `ACTIVE`. Existe para poder repetir el flujo completo sin resembrar la
base de datos.

**No forma parte del modelo de seguridad, y está construido para que se note:**

- Está desactivado por defecto: sin la variable, la ruta `POST /api/cards/:id/reset` **no se
  registra siquiera**.
- Vive en `src/api/routes.ts`, deliberadamente **fuera de `cardBlockService`**, para que el núcleo
  de seguridad no tenga ningún camino de desbloqueo.
- **Nunca se expone como tool MCP.** El agente no puede desbloquear nada, ni con el flag activo.
- Exige la cookie de sesión y sólo alcanza tarjetas del propio titular, igual que el resto del
  canal humano.
- Queda registrado en la auditoría como `card.reset_demo`, para que el log no mienta sobre cómo
  cambió el estado de una tarjeta.

Un desbloqueo real sería una acción *fail-dangerous* y necesitaría su propio flujo de propuesta y
confirmación, con más controles que el bloqueo, no menos — ver §8, fuera de alcance.

## 11. Trade-offs

El razonamiento de cada uno está donde le corresponde en las secciones anteriores; se recogen aquí
juntos porque son las decisiones de diseño con una alternativa razonable descartada a propósito:

- **"No encontrado" en vez de "prohibido"** (C1, §2). Un `card_ref` de otra sesión y uno que
  directamente no existe devuelven el mismo error. Se pierde algo de precisión en el mensaje, a
  cambio de que un agente comprometido no pueda distinguir ambos casos y enumerar así qué tarjetas
  existen fuera de su sesión por ensayo y error.
- **Clave de idempotencia por sesión, no por tarjeta** (§7). `hash(session_key, card_id, action,
  reason)` — `session_key` es el hash del access token OAuth (§3) — permite que dos sesiones del
  mismo cliente generen dos propuestas independientes para la misma tarjeta. Es inocuo con
  `card.block`, porque bloquear es idempotente en efecto; con una acción como desbloquear o
  transferir dejaría de serlo, y la clave tendría que subir a nivel de tarjeta.
- **Ejecución síncrona, sin cola ni worker.** La ejecución ocurre dentro de la misma petición de
  confirmación, con un pequeño retardo artificial para que `EXECUTING` sea un estado real y no
  instantáneo. Es más simple que montar una cola de trabajos, a costa de mantener la petición HTTP
  de confirmación abierta mientras dura la ejecución — aceptable para el volumen y el alcance de
  esta prueba, no necesariamente para producción a escala.
- **Cruce tarjeta↔propuesta en el cliente, no en el servidor.** `GET /api/proposals` devuelve el
  `cardId` en bruto; es la SPA (`web/src/pages/Inbox.tsx`, función `cardLabel`) quien lo resuelve
  contra `GET /api/cards` para mostrar marca y últimos 4 dígitos. Mantiene el DTO de propuesta y el
  dominio ajenos a detalles de presentación, a cambio de que el frontend tenga que pedir y cruzar
  dos colecciones en vez de recibir una ya enriquecida por el servidor.
