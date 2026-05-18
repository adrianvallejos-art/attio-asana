# Handoff: Integración Attio ↔ Asana — Onboarding & Client Portfolio Sync

> **Repositorio:** `adrianvallejos-art/attio-asana-sync`
> **Producción:** `https://attio-asana-sync.vercel.app`
> **Actualizado:** 2026-05-08

---

## Índice

1. [Qué hace esta integración](#1-qué-hace-esta-integración)
2. [Stack y arquitectura](#2-stack-y-arquitectura)
3. [Plataformas: particularidades críticas](#3-plataformas-particularidades-críticas)
4. [IDs, GIDs y slugs de referencia](#4-ids-gids-y-slugs-de-referencia)
5. [Flujo 1: Asana → Attio (sincronización de status)](#5-flujo-1-asana--attio)
6. [Flujo 2: Attio → Asana (creación automática de proyectos)](#6-flujo-2-attio--asana)
7. [Fase 3: Organización de portfolios de clientes](#7-fase-3-organización-de-portfolios-de-clientes)
8. [Endpoints de la API](#8-endpoints-de-la-api)
9. [Scripts de utilidad (one-off)](#9-scripts-de-utilidad-one-off)
10. [Base de datos (Supabase)](#10-base-de-datos-supabase)
11. [Variables de entorno](#11-variables-de-entorno)
12. [Deploy](#12-deploy)
13. [Tareas pendientes (TODOs)](#13-tareas-pendientes-todos)
14. [Problemas conocidos y soluciones aplicadas](#14-problemas-conocidos-y-soluciones-aplicadas)

---

## 1. Qué hace esta integración

La integración conecta el CRM **Attio** con el gestor de proyectos **Asana** para el equipo de Onboarding y CSM de AtomChat. Cubre tres áreas:

### Flujo A — Asana → Attio (activo)

Cada vez que un CSM publica un *status update* en un proyecto de Asana, se crea automáticamente una **nota en el record de Onboarding en Attio** con el contenido de esa actualización.

```
CSM publica status en Asana
        ↓
Asana dispara webhook → /api/asana-webhook
        ↓
Se inserta sync_event en Supabase
        ↓
Se llama /api/onboarding-sync
        ↓
Se crea nota en Attio (record de Onboarding)
```

### Flujo B — Attio → Asana (código completo, pendiente de configurar)

Cuando se crea un nuevo record en el objeto **Onboarding** de Attio, se crea automáticamente un proyecto en Asana duplicando un template, con todos los campos configurados.

```
Se crea record en Attio (objeto: onboardings)
        ↓
Attio dispara webhook → /api/attio-onboarding-webhook
        ↓
Duplica proyecto template en Asana
        ↓
Configura nombre, fechas, campos custom, descripción
        ↓
Agrega a portfolio OB Customers + crea portfolio del cliente
        ↓
Actualiza las 2 tareas clave del proyecto
        ↓
Registra webhook de Asana para sincronización futura
        ↓
Crea mapping en Supabase
```

### Fase C — Organización de portfolios de clientes (completado via scripts)

Se creó la estructura de portfolios de clientes en Asana bajo el portfolio principal **"Clientes"**. Cada sub-portfolio de cliente agrega sus proyectos de ONB, Tickets e implementación de CSM, y se pobla con datos de Attio (plan, industria, MRR, URL, owner).

```
Portfolio "Clientes" (1213481895234783)
  └─ Sub-portfolio "Nombre del cliente" (custom fields: Atom ID, Attio Company ID, URL Attio, Plan, Ciclo de vida, Total MRR, Industria, Owner)
       ├─ Proyecto ONB
       ├─ Proyecto Tickets
       └─ Portfolio/Proyectos CSM
```

---

## 2. Stack y arquitectura

| Capa | Tecnología | Detalle |
|------|-----------|---------|
| API | Vercel Serverless Functions | Node.js ESM, archivos en `/api/*.js` |
| Base de datos | Supabase (PostgreSQL) | Cola de eventos + mappings |
| CRM | Attio v2 REST API | Records, notas, webhooks |
| PM | Asana REST API 1.0 | Proyectos, status updates, webhooks, portfolios |
| Deploy | Vercel (plan Hobby) | Límite: **12 serverless functions máximo** |
| Repo | GitHub | rama `main` → auto-deploy en Vercel |

### Diagrama de archivos

```
attio-asana/
├── api/
│   ├── _asanaHelper.js               ← wrapper Asana API (helper, no expone endpoint)
│   ├── _attioHelper.js               ← wrapper Attio API (helper, no expone endpoint)
│   ├── asana-webhook.js              ← recibe eventos de Asana (POST)
│   ├── attio-onboarding-webhook.js   ← recibe eventos de Attio (POST)
│   ├── attio-notes.js                ← gestión de notas Attio (GET/DELETE)
│   ├── backfill-atom-ids.js          ← backfill táctica de Atom IDs (POST)
│   ├── daily-reconcile.js            ← cron diario de reconciliación (GET/POST)
│   ├── dashboard-data.js             ← datos para el dashboard (GET)
│   ├── onboarding-sync.js            ← procesa sync_event → crea nota Attio (POST)
│   ├── register-webhook.js           ← gestión de webhooks Asana (GET/POST/DELETE)
│   ├── trim-field-spaces.js          ← limpieza de espacios en campos Asana (POST)
│   └── update-project-fields.js      ← actualiza campos custom en Asana (POST)
├── config/
│   └── onboarding-config.js          ← GIDs centralizados para Flujo B
├── supabase/
│   └── migrations/
│       ├── 001_onboarding_sync.sql
│       └── 002_status_gid_dedup.sql
├── vercel.json                       ← cron + función config
├── package.json
├── HANDOFF.md                        ← este documento
├── PRD.md                            ← Product Requirements Document
│
│   [scripts one-off — NO son endpoints, se ejecutan localmente]
├── setup-client-portfolios.js        ← fase inicial: fix Nebula, Cofiño, Autoland, Tanner
├── create-all-client-portfolios.js   ← creación masiva de sub-portfolios de clientes
├── backfill-missing-plans.js         ← rellena Plan contratado desde Attio
├── sync-portfolio-data.js            ← sincroniza nombre, MRR e industria desde Attio
├── update-portfolio-owners.js        ← asigna owner a cada carpeta de cliente
│
│   [logs de scripts — NO commitear en producción]
├── create-portfolios-log.json
├── backfill-plans-log.json
├── sync-portfolio-data-log.json
└── update-owners-log.json
```

---

## 3. Plataformas: particularidades críticas

### 3.1 Asana

**API:** `https://app.asana.com/api/1.0`
**Autenticación:** Personal Access Token en header `Authorization: Bearer <token>`

#### Webhooks de Asana
- Asana hace un **handshake** antes de empezar a enviar eventos: manda un POST con el header `X-Hook-Secret` y espera que el servidor lo devuelva en la respuesta con el mismo header. Si no se hace correctamente, el webhook queda inactivo.
- Los webhooks se registran por proyecto (no globalmente). Cada proyecto de Onboarding necesita su propio webhook.
- El filtro correcto para capturar solo status updates: `{ resource_type: 'project_status', action: 'added' }`. **No** incluir `{ resource_type: 'project', action: 'changed' }` porque genera eventos espurios.
- Los eventos llegan con esta estructura:
  ```json
  {
    "events": [{
      "resource": { "gid": "1234567890", "resource_type": "project_status" },
      "parent":   { "gid": "9876543210", "resource_type": "project" },
      "action":   "added"
    }]
  }
  ```

#### Custom Fields en Asana

Los campos custom se identifican por GID. Para leer: `opt_fields=custom_fields.name,custom_fields.gid,custom_fields.text_value,custom_fields.display_value`. Para escribir: PUT al proyecto con `{ data: { custom_fields: { [gid]: valor } } }`.

**En proyectos de Onboarding (OB Customers):**

| Campo | GID |
|-------|-----|
| Atom ID | `1210444217947526` |
| Attio Company ID | `1213632895496591` |
| Attio ONB ID | `1213632821526315` |
| Ciclo de vida | `1210562547163309` |
| Plan contratado | `1212945918780798` |
| Industria | `1209758682431708` |
| País | `1209758683683903` |
| New MRR estimado | `1209758682431717` |
| Total MRR | `1214622504155723` |
| URL Attio | `1214246840300235` |
| URL del SOW | `1214246218059996` |
| URL del Baseline | `1214246217970016` |

**En portfolios de clientes (bajo "Clientes"):**

| Campo | GID |
|-------|-----|
| Atom ID | `1210444217947526` |
| Attio Company ID | `1213632895496591` |
| URL Attio | `1214246840300235` |
| Ciclo de vida | `1210562547163309` |
| Plan contratado | `1212945918780798` |
| Industria | `1209758682431708` |
| Total MRR | `1214622504155723` |

**Opciones de Plan contratado:**

| Opción | GID |
|--------|-----|
| Team | `1212945918780799` |
| Professional | `1212945918780800` |
| Enterprise | `1212945918780801` |

**Opciones de Industria:**

| Industria | GID | Valores Attio mapeados |
|-----------|-----|------------------------|
| Automotriz | `1209758682431710` | Automotive |
| Educación | `1209758682431709` | Education, Primary/Secondary Education |
| Financiera | `1209758682431711` | Financial Services, Insurance, Servicios financieros |
| Retail | `1209758682431713` | Retail, Consumer Goods, Sporting Goods |
| Real Estate | `1209758682431712` | Real Estate |
| Salud | `1209758682431714` | Health, Wellness and Fitness; Hospital & Health Care; Pharmaceuticals; Cosmetics |
| Otros | `1210279392466247` | IT & Services, Entertainment, Construction, Mining, Telecom, Oil & Energy, Food, Machinery, Utilities, Internet, Transport, Environmental, Graphic Design, Services |

**Opción de Ciclo de vida al crear:**

| Opción | GID |
|--------|-----|
| Cliente (inicial) | `1210562547163312` |

#### Portfolios relevantes

| Portfolio | GID |
|-----------|-----|
| OB Customers | `1209745158203291` |
| Clientes Solicitudes | `1213027143201381` |
| **Clientes** (principal) | `1213481895234783` |

#### Duplication de proyectos (Flujo B)
La API de duplicación de Asana es **asíncrona**: devuelve un job GID y hay que hacer polling hasta que el job llegue a `status: 'completed'`. El campo `new_project.gid` del job completado contiene el GID del proyecto nuevo.

---

### 3.2 Attio

**API:** `https://api.attio.com/v2`
**Autenticación:** `Authorization: Bearer <ATTIO_API_TOKEN>`

#### Objetos relevantes
- `onboardings` — records de onboarding (uno por cliente)
- `companies` — empresas
- `deals` — deals/oportunidades

#### Atributos utilizados

**Companies:**

| Slug | Tipo | Uso |
|------|------|-----|
| `name` | text | Nombre de la empresa |
| `atom_id` | text | ID de cuenta en AtomChat |
| `atom_plan` | select | Plan contratado (Team/Professional/Enterprise) |
| `industria` | select | Industria de la empresa |
| `total_mrr` | currency | MRR total del cliente |
| `propietario_csm` | workspace-member | CSM responsable |

**Onboarding:**

| Slug | Tipo | Uso |
|------|------|-----|
| `propietario_onboarding` | workspace-member | Owner del onboarding |
| `company` | record-reference | Asociación a Company |
| `deal` | record-reference | Asociación a Deal |
| `industria` | select | Industria |
| `primary_location` | location | País |

**Deals:**

| Slug | Tipo | Uso |
|------|------|-----|
| `name` | text | Nombre del deal |
| `mrr` | number | MRR del deal |
| `owner` | workspace-member | Owner del deal |
| `partner` | record-reference | Partner asociado |
| `link_de_sow` | text/url | URL del SOW |
| `i_link_del_baseline_y_roi` | text/url | URL del Baseline/ROI |

#### Filtros en queries
```json
{
  "filter": { "atom_id": { "$eq": "12345" } },
  "limit": 10
}
```

#### Notas en Attio
```json
POST /notes
{
  "data": {
    "title": "Título",
    "content": "Cuerpo en texto plano",
    "format": "plaintext",
    "parent_object": "onboardings",
    "parent_record_id": "uuid-del-record"
  }
}
```

#### Formato de valores para PATCH
```js
// Campo tipo select/status
{ "proposal_status": [{ "option": "Accepted" }] }

// Campo tipo text
{ "atom_id": [{ "value": "12345" }] }
```

---

### 3.3 Supabase

**Autenticación desde la API:** `SUPABASE_URL` + `SUPABASE_ANON_KEY` con RLS `allow_all`

Las tres tablas principales:

| Tabla | Propósito |
|-------|-----------|
| `onboarding_mapping` | Relaciona `asana_project_gid` ↔ `attio_record_id` |
| `sync_events` | Cola de eventos a procesar (Asana → Attio) |
| `asana_webhook_subs` | Registro de webhooks activos de Asana |

El índice único `sync_events_asana_status_gid_unique` (parcial) evita notas duplicadas.

---

### 3.4 Vercel

**Plan:** Hobby — límite de **12 Serverless Functions** por deployment.
Actualmente hay exactamente 12 funciones en `/api/` (los helpers con prefijo `_` y los archivos en `/config/` no cuentan).

**Timeout:** 60s para todas las funciones.
**Cron:** `daily-reconcile` se ejecuta a las 08:00 UTC.

---

## 4. IDs, GIDs y slugs de referencia

### Asana — Workspace y equipo

| Concepto | GID |
|---------|-----|
| Workspace | `1176142409313345` |
| Equipo Onboarding | `1204050191559311` |

### Asana — Owners (email → GID)

| Email | GID de usuario en Asana |
|-------|------------------------|
| mariana.guzman@atomchat.io | `1204602972500504` |
| esteban.urla@atomchat.io | `1209696317018479` |
| carlos.macias@atomchat.io | `1209673330260179` |
| elvis.ventocilla@atomchat.io | `1210145836854490` |
| felix.morales@atomchat.io | `1203091756184685` |
| carolina.sanfortunato@atomchat.io | `1209696453800561` |
| renata.blanco@atomchat.io | `1212999280498569` |
| diego.pereda@atomchat.io | `1211757602000299` |
| maria.pereira@atomchat.io | `1211973339004111` |
| martin.portillo@atomchat.io | `1200448220334225` |
| eholmann@atomchat.io | `15298974574373` |
| vochoa@atomchat.io | `1191256770503035` |
| leidy.zapata@atomchat.io | `1212386013355465` |
| laura.devia@atomchat.io | `1211360762748309` |
| dulce.rodriguez@atomchat.io | `1207824112977859` |
| jesus.roque@atomchat.io | `1209174137824462` |
| angie.agudelo@atomchat.io | `1213961052579306` |
| wendy.gonzalez@atomchat.io | `1204204881595637` |
| claudia.joya@atomchat.io | `1205270423291979` |
| mario.subuyuj@atomchat.io | `1212245548562482` |
| gabrielacid@atomchat.io | `1209890049405172` |
| guadalupe.castagnoviz@atomchat.io | `1214152301304977` |

### Mapeo Attio industria → Asana enum GID

| Valor en Attio | GID opción Asana |
|---------------|-----------------|
| Automotive | `1209758682431710` |
| Education | `1209758682431709` |
| Financial Services | `1209758682431711` |
| Retail | `1209758682431713` |
| Real Estate | `1209758682431712` |
| Insurance | `1209758682431711` |
| Health, Wellness and Fitness | `1209758682431714` |
| Hospital & Health Care | `1209758682431714` |
| Pharmaceuticals | `1209758682431714` |
| Consumer Goods | `1209758682431713` |
| Sporting Goods | `1209758682431713` |
| Information Technology and Services | `1210279392466247` |
| Entertainment | `1210279392466247` |
| Construction | `1210279392466247` |
| Telecommunications | `1210279392466247` |
| Food & Beverages | `1210279392466247` |
| Servicios financieros | `1209758682431711` |
| Graphic Design | `1210279392466247` |

### URLs de producción

| Endpoint | URL |
|----------|-----|
| Webhook Asana | `https://attio-asana-sync.vercel.app/api/asana-webhook` |
| Webhook Attio | `https://attio-asana-sync.vercel.app/api/attio-onboarding-webhook` |
| Dashboard data | `https://attio-asana-sync.vercel.app/api/dashboard-data` |

---

## 5. Flujo 1: Asana → Attio

### Paso a paso

```
1. CSM publica un status update en el proyecto de Asana

2. Asana dispara un POST a /api/asana-webhook con el evento

3. asana-webhook.js:
   a. Si hay X-Hook-Secret → handshake, se devuelve el secret
   b. Filtra solo eventos project_status + added
   c. Agrupa por proyecto
   d. Para cada proyecto:
      - Busca en Supabase el attio_record_id
      - Si no hay mapping: lee "Attio ONB ID" del proyecto (auto-discovery)
      - Si no hay Attio ID: skip silencioso
      - Inserta sync_event (status='pending')
      - Si asana_status_gid ya existe (error 23505): skip
   e. Para cada sync_event, llama síncronamente a /api/onboarding-sync

4. onboarding-sync.js:
   a. Lee el sync_event
   b. Marca como 'processing'
   c. Fetch del proyecto Asana (nombre)
   d. Fetch de los últimos 3 status updates
   e. Resuelve URLs de Asana en el texto
   f. Construye el contenido de la nota
   g. Crea la nota en Attio via POST /notes
   h. Si status es 'complete' o 'red', actualiza propiedades en Attio
   i. Marca el sync_event como 'completed'
```

### Reconciliación diaria

`daily-reconcile.js` corre automáticamente a las 08:00 UTC. Revisa los últimos 7 días de status updates de todos los proyectos activos con Attio ID y procesa cualquiera no registrado en `sync_events`.

---

## 6. Flujo 2: Attio → Asana

> **Estado actual:** Código completo. Pendiente completar los `TODO` en `config/onboarding-config.js`.

Al crear un onboarding en Attio:

1. Obtiene datos del record de Onboarding (industry, country, owner)
2. Traversa asociaciones a Company y Deal
3. Duplica el proyecto template en Asana (operación asíncrona con polling)
4. Nombre del proyecto: `{nombre del deal} - ONB`
5. Fechas: inicio = fecha de creación, fin = inicio + 1 mes
6. Configura: nombre, visibilidad, fechas, descripción, campos custom, owner
7. Agrega al portfolio `OB Customers` + crea un sub-portfolio con el nombre de la empresa
8. Actualiza 2 tareas del template reemplazando `{{CLIENT}}` con el nombre del cliente
9. Registra webhook de Asana en el nuevo proyecto
10. Crea el mapping en Supabase

---

## 7. Fase 3: Organización de portfolios de clientes

Se ejecutaron scripts one-off para construir la estructura de portfolios bajo **"Clientes" (GID: `1213481895234783`)**. Esta fase está completada.

### Estructura resultante

```
Portfolio "Clientes"
  └─ Sub-portfolio del cliente (uno por Atom ID único)
       ├─ Proyectos de Onboarding (fuente: OB Customers)
       ├─ Proyectos de Tickets (fuente: Clientes Solicitudes)
       └─ Portfolios/Proyectos de CSM
```

### Campos custom en cada sub-portfolio de cliente

| Campo | GID | Fuente |
|-------|-----|--------|
| Atom ID | `1210444217947526` | Extraído de proyectos existentes |
| Attio Company ID | `1213632895496591` | Extraído de proyectos o buscado en Attio |
| URL Attio | `1214246840300235` | Generada: `https://app.attio.com/atomchat/company/{coId}/overview` |
| Ciclo de vida | `1210562547163309` | Opción fija "Cliente" (`1210562547163312`) |
| Plan contratado | `1212945918780798` | Leído de `atom_plan` en Attio Company |
| Industria | `1209758682431708` | Leído de `industria` en Attio Company, mapeado a enum |
| Total MRR | `1214622504155723` | Leído de `total_mrr` en Attio Company (currency_value) |
| Owner | — | Del owner del proyecto ONB o de `propietario_onboarding` / `propietario_csm` en Attio |

### Scripts ejecutados (en orden)

1. **`setup-client-portfolios.js`** — Fix inicial: Nebula, Cofiño, Autoland, Tanner (4 clientes piloto)
2. **`create-all-client-portfolios.js`** — Creación masiva del resto de clientes desde portfolios ONB, Tickets y CSM
3. **`backfill-missing-plans.js`** — Rellena Plan contratado y Attio Company ID en carpetas creadas sin ese dato (busca en Attio por Atom ID)
4. **`sync-portfolio-data.js`** — Sincroniza nombre (desde Attio), MRR e Industria; mergea 2 portfolios duplicados
5. **`update-portfolio-owners.js`** — Asigna el owner de cada carpeta (prioridad: owner del ONB; fallback: `propietario_csm` en Attio)

### Owner de portfolios de clientes

> **LIMITACIÓN CRÍTICA DE LA API:** El campo `owner` en portfolios de Asana **solo es escribible en el momento de creación (POST)**. La API retorna `Cannot write this property` en cualquier intento de PUT posterior.

**Para portfolios nuevos (Flujo B):** usar el módulo HTTP en Make con un POST directo a `https://app.asana.com/api/1.0/portfolios` incluyendo el campo `owner`. El módulo nativo "Create a Portfolio" de Make **no expone** el campo owner.

```json
{
  "data": {
    "name": "{{nombre_cliente}}",
    "workspace": { "gid": "1176142409313345" },
    "owner": { "gid": "{{gid_asana_del_propietario}}" },
    "color": "light-green",
    "public": true
  }
}
```

**Para portfolios existentes sin owner correcto:** solo modificable desde la UI de Asana → `⋯` → Settings → Transfer ownership.

**Lógica de resolución del owner:**
1. Buscar proyecto ONB en OB Customers con el mismo Atom ID → usar su owner en Asana
2. Si no hay ONB → leer `propietario_onboarding` de Attio Company → mapear email a GID de Asana
3. Si no hay `propietario_onboarding` → usar `propietario_csm` de Attio Company

### Duplicados resueltos

| Cliente | Keep GID | Drop GID (eliminado) |
|---------|----------|----------------------|
| Santa Maria | `1214588323031446` | `1214588446794712` |
| Div Design + Umani | `1214588084019874` | `1214588322197760` |

### Clientes excluidos del backfill masivo (ya existían)
`Cofiño`, `Autoland`, `Tanner`, `Nebula` — procesados en la fase piloto inicial.

---

## 8. Endpoints de la API

### `POST /api/asana-webhook`
Recibe eventos de Asana. Maneja handshake automáticamente.

### `POST /api/attio-onboarding-webhook`
Recibe eventos de Attio. Ejecuta el flujo completo de creación de proyecto.

### `GET /api/dashboard-data`
Devuelve todos los proyectos de Onboarding con estado de sincronización.
```json
{ "summary": { "total": 127, "active": 45, ... }, "projects": [...] }
```

### `POST /api/onboarding-sync`
Procesa un sync_event pendiente.
```json
{ "sync_event_id": "uuid" }
```

### `GET /api/register-webhook`
Lista webhooks y mappings activos.

### `POST /api/register-webhook`
Registra webhook + mapping manualmente.
```json
{ "asana_project_gid": "...", "attio_record_id": "...", "assigned_onb_email": "...", "team": "onboarding" }
```

### `DELETE /api/register-webhook`
Elimina un webhook.
```json
{ "webhook_gid": "..." }
```

### `POST /api/update-project-fields`
Actualiza campos custom de un proyecto en Asana.
```json
{ "asana_project_gid": "...", "field_gids": {...}, "atom_id": "...", "attio_company_id": "uuid", "attio_onb_id": "uuid" }
```

### `GET /api/attio-notes?attio_record_id=uuid`
Lista las notas de un record de Attio.

### `DELETE /api/attio-notes`
Elimina una nota de Attio.
```json
{ "note_id": "..." }
```

### `POST /api/backfill-atom-ids`
Rellena el campo "Atom ID" en Asana extrayéndolo del nombre del proyecto `"Company (AtomID)"`.
**Solo para proyectos del portfolio "Clientes Solicitudes".**
```json
{ "dry_run": true, "force": false, "offset": 0, "limit": 20 }
```

### `POST /api/trim-field-spaces`
Detecta y elimina espacios en campos Atom ID, Attio Company ID y Attio ONB ID en todos los proyectos.
Si el ONB ID pasa a ser UUID válido tras el trim, registra webhook y procesa el último status.
```json
{ "dry_run": true, "offset": 0, "limit": 30 }
```

### `GET|POST /api/daily-reconcile`
Reconciliación manual. Revisa los últimos 7 días.

---

## 9. Scripts de utilidad (one-off)

Estos scripts **no son endpoints** — se ejecutan directamente con Node.js en la máquina del desarrollador. Requieren `.env.local` con las variables de entorno.

```bash
# Ejecución con variables de entorno
node --env-file=.env.local nombre-del-script.js

# Modo dry run (no escribe nada)
node --env-file=.env.local nombre-del-script.js --dry-run
```

| Script | Propósito | Estado |
|--------|-----------|--------|
| `setup-client-portfolios.js` | Fix inicial para 4 clientes piloto | Completado |
| `create-all-client-portfolios.js` | Creación masiva de sub-portfolios | Completado |
| `backfill-missing-plans.js` | Rellena Plan contratado desde Attio | Completado |
| `sync-portfolio-data.js` | Sincroniza nombre, MRR, industria + merge duplicados | Completado |
| `update-portfolio-owners.js` | Asigna owners a carpetas de clientes | Completado |
| `populate-asana-pais.js` | Puebla campo "País" en portfolios Clientes desde Attio `primary_location.country_code` | Completado (164/165 — Derco Colombia sin ubicación en Attio) |

**`populate-asana-pais.js` — detalles:**
- Lee portfolios de "Clientes" (GID `1213481895234783`), lee campo "Attio Company ID" (GID `1213632895496591`)
- Consulta `GET /v2/objects/companies/records/{id}` en Attio → `values.primary_location[0].country_name`
- Mapea al enum "País" (GID `1209758683683903`) — 19 países cubiertos (ver COUNTRY_MAP en el script)
- Países SIN mapeo (campo queda vacío): Cuba, Uruguay, Venezuela, Portugal
- Attio devuelve `country_code` (ISO 3166-1 alpha-2), NO `country_name` — el script usa `country_code`
- Variable de entorno usada: `ATTIO_API_TOKEN` (el script acepta también `ATTIO_API_KEY` o `VITE_ATTIO_API_TOKEN`)
- Soporta `--dry-run`
- **Run completado 2026-05-18:** 164 actualizados, 1 sin country (Derco Colombia — falta ubicación en Attio)

Los archivos `*-log.json` son salidas de esos scripts y contienen el estado final de cada operación. No deben commitearse a producción (agregar a `.gitignore` si se usa el repo para trabajo colaborativo).

---

## 10. Base de datos (Supabase)

### `onboarding_mapping`

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `attio_record_id` | text UNIQUE | UUID del record en Attio |
| `asana_project_gid` | text UNIQUE | GID del proyecto en Asana |
| `assigned_onb_email` | text | Email del CSM asignado (opcional) |
| `team` | text | Siempre `'onboarding'` |
| `active` | boolean | `true` = activo |
| `created_at` / `updated_at` | timestamptz | Auto-gestionados |

### `sync_events`

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `source` | text | `'asana'` o `'attio'` |
| `event_type` | text | `'status_update'` |
| `asana_project_gid` | text | GID del proyecto |
| `attio_record_id` | text | UUID del record Attio |
| `asana_status_gid` | text | GID del status update (dedup) |
| `payload` | jsonb | Datos del evento |
| `ai_analysis` | jsonb | Resultado del procesamiento |
| `status` | text | `pending` → `processing` → `completed` / `failed` |
| `error_message` | text | Error si falló |
| `retry_count` | int | Intentos realizados |

**Índice crítico:** `sync_events_asana_status_gid_unique` — único parcial, evita notas duplicadas.

### `asana_webhook_subs`

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | uuid | PK |
| `asana_project_gid` | text | GID del proyecto |
| `webhook_gid` | text UNIQUE | GID del webhook en Asana |
| `active` | boolean | `true` = activo |
| `x_hook_secret` | text | Secret recibido en el handshake |
| `created_at` | timestamptz | |

---

## 11. Variables de entorno

| Variable | Descripción |
|----------|-------------|
| `ASANA_ACCESS_TOKEN` | Personal Access Token de Asana |
| `ATTIO_API_TOKEN` | API Token de Attio |
| `SUPABASE_URL` | URL del proyecto Supabase |
| `SUPABASE_ANON_KEY` | Anon key de Supabase |
| `APP_URL` | `https://attio-asana-sync.vercel.app` |
| `ATTIO_ONBOARDING_SLUG` | Slug del objeto onboarding (default: `'onboardings'`) |

Para desarrollo local: `.env.local` (está en `.gitignore`). Los scripts one-off usan `--env-file=.env.local`.

---

## 12. Deploy

```bash
git add api/archivo-modificado.js
git commit -m "feat: descripción del cambio"
git push origin main
vercel --prod   # Solo el owner lo ejecuta desde su terminal
```

**Por qué el owner debe hacer el deploy:** Vercel plan Hobby restringe los deploys a producción a la cuenta del dueño del proyecto.

Verificar committer antes de cada commit:
```bash
git config --local user.email   # debe ser: adrian.vallejos@atomchat.io
git config --local user.name    # debe ser: Adrián Vallejos
```

---

## 13. Tareas pendientes (TODOs)

### Flujo 2 — Attio → Asana (BLOQUEANTE para activar)

Completar en `config/onboarding-config.js`:

```js
// 1. GID del proyecto template
template_project_gid: 'TODO',

// 2. GIDs de campos custom del proyecto de ONB
fields: {
  mrr:          'TODO',
  industry:     'TODO',
  country:      'TODO',
  sow_url:      'TODO',
  baseline_url: 'TODO',
  attio_url:    'TODO',
}

// 3. Mapeos de industria y country (ver sección 4 para los de portfolios — estos son para proyectos ONB)
industry_map: { ... }
country_map:  { ... }

// 4. Nombres exactos de las 2 tareas del template
tasks_to_update: ['Nombre de tarea 1', 'Nombre de tarea 2'],

// 5. GIDs de campos en tareas
task_fields: { industry: 'TODO', country: 'TODO' }
```

Una vez completados, activar en Attio → Settings → Webhooks → Create:
- URL: `https://attio-asana-sync.vercel.app/api/attio-onboarding-webhook`
- Events: `record.created`, Object: `onboardings`

### Backfill pendiente

Ejecutar el run real del backfill de "Clientes Solicitudes" en páginas de 20:
```powershell
Invoke-RestMethod -Method POST -Uri "https://attio-asana-sync.vercel.app/api/backfill-atom-ids" -ContentType "application/json" -Body '{"dry_run": false, "offset": 0, "limit": 20}'
# Repetir incrementando offset (0, 20, 40, ... hasta ~100)
```

### Próximas fases (ver PRD.md)

1. **Tabla Supabase para status de portfolios** — Vista consolidada del estado de todos los proyectos (ONB y CSM) por cliente.
2. **Reemplazar Make** — Migrar la automatización de creación de proyectos Asana desde Attio a esta solución propia.
3. **Actualización de propiedades en Attio** — Los status updates de Asana actualizan campos del objeto Onboarding (y Company) en Attio.
4. **Agente IA en Slack** — Procesamiento de llamadas registradas en Attio para gestión inteligente de tareas.

---

## 14. Problemas conocidos y soluciones aplicadas

### Espacios en valores UUID de campos custom de Asana
**Síntoma:** Proyectos con `Attio ONB ID = " 5733fc31-... "` no pasan la validación UUID y quedan sin webhook.
**Solución:** `trim-field-spaces.js` detecta, limpia y registra el webhook automáticamente si el trim produce un UUID válido. `dashboard-data.js` también aplica `.trim()` al leer.

### Webhooks de Asana con filtro incorrecto (legado)
**Síntoma:** Llegaban eventos `project + changed` que generaban notas espurias.
**Solución:** `createWebhook()` en `_asanaHelper.js` solo usa `{ resource_type: 'project_status', action: 'added' }`. Los webhooks viejos hay que eliminarlos y re-registrar.

### Límite de 12 funciones en Vercel Hobby
Si se necesita un nuevo endpoint, primero hay que eliminar o consolidar uno existente.

### Timeout en operaciones de backfill
Las operaciones sobre muchos proyectos pueden superar los 60s. Solución: paginación con `offset/limit` + `Promise.allSettled` con concurrencia de 10.

### Grupo UMANI — duplicate Attio record ID
Dos proyectos de Asana apuntaban al mismo `attio_record_id`. Revisado en los duplicados de portfolios. Verificar en `onboarding_mapping` si persiste algún conflicto.

### Portfolios duplicados (Santa Maria, Div Design + Umani)
Dos atom IDs distintos apuntaban a la misma Company en Attio. Resuelto en `sync-portfolio-data.js`: se conservó el portfolio correcto y se removió el duplicado del portfolio padre.

---

*Última actualización: 2026-05-18. `populate-asana-pais.js` completado — 164/165 portfolios con País poblado.*
