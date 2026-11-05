/**
 * Configuración centralizada para la automatización Attio → Asana.
 * Completar los valores marcados con TODO antes del primer deploy.
 */

// ─── Asana ────────────────────────────────────────────────────────────────────

export const ASANA = {
  workspace_gid:      '1176142409313345',
  team_gid:           '1204050191559311', // Onboarding team
  portfolio_ob_gid:   '1209745158203291', // OB Customers

  // GID del proyecto template a duplicar — TODO: completar cuando esté listo
  template_project_gid: 'TODO',

  // GIDs de campos custom del proyecto
  fields: {
    ciclo_de_vida:     '1210562547163309',
    attio_company_id:  '1213632895496591',
    attio_onb_id:      '1213632821526315',
    mrr:               'TODO', // GID del campo MRR en Asana
    industry:          'TODO', // GID del campo Industry en Asana
    country:           'TODO', // GID del campo Country en Asana
    sow_url:           'TODO', // GID del campo SOW URL en Asana
    baseline_url:      'TODO', // GID del campo Baseline URL en Asana
    attio_url:         'TODO', // GID del campo Attio URL en Asana (si existe)
  },

  // Valor fijo de Ciclo de vida al crear
  ciclo_de_vida_initial_option: '1210562547163312',

  // Mapeo: valor de Attio (industria slug/label) → GID de opción en Asana
  // TODO: completar con los valores exactos de Attio y los GIDs de Asana
  industry_map: {
    // 'saas':        '1209xxxxxxxxx',
    // 'fintech':     '1209xxxxxxxxx',
    // 'ecommerce':   '1209xxxxxxxxx',
    // 'educacion':   '1209xxxxxxxxx',
    // 'salud':       '1209xxxxxxxxx',
  },

  // Mapeo: valor de country en Attio → GID de opción en Asana
  // TODO: completar
  country_map: {
    // 'MX': '1209xxxxxxxxx',
    // 'CO': '1209xxxxxxxxx',
    // 'PE': '1209xxxxxxxxx',
    // 'CL': '1209xxxxxxxxx',
    // 'AR': '1209xxxxxxxxx',
  },

  // Nombres de las 2 tareas del template que hay que actualizar con el cliente
  // TODO: completar con los nombres exactos tal como aparecen en el template
  tasks_to_update: [
    // 'Nombre de tarea 1 en el template',
    // 'Nombre de tarea 2 en el template',
  ],

  // GIDs de campos custom en las tareas (para Industry y Country)
  task_fields: {
    industry: 'TODO',
    country:  'TODO',
  },
};

// ─── CSM Proyectos (módulo "Proyectos" de csm-audit) ──────────────────────────
// GIDs verificados por API el 2026-10-09 contra el proyecto "Plantilla CSM".
// Distinto del flujo de Onboarding arriba: una misma cuenta puede tener
// múltiples proyectos CSM a lo largo del tiempo, todos duplicados de esta
// plantilla.
export const CSM_PROJECT = {
  workspace_gid:       '1176142409313345',
  template_project_gid: '1219284422967329', // "Plantilla CSM"

  // Texto que identifica la sección molde a renombrar por iniciativa — match
  // por substring, no por nombre exacto: la plantilla real se llama
  // "3. Iniciativa 1 · [Nombre]" (el número de orden puede cambiar si se
  // reordenan secciones en Asana), así que buscar el literal '[Iniciativa 1]'
  // nunca matcheaba y el placeholder nunca se renombraba (bug encontrado
  // 2026-10-12: siempre se creaba una sección nueva en su lugar).
  initiative_section_placeholder: 'Iniciativa 1',

  // Nombres de las tareas (secciones "1. Diagnóstico" y "2. Plan de acción")
  // cuya descripción se completa con los links de los pasos 1 y 2 del wizard
  // de Proyectos al crear el proyecto (ver handleCreate en api/csm-project.js).
  baseline_task_name: 'Baseline',
  sow_task_name: 'SOW',

  // Tareas fijas que ya vienen en la plantilla dentro de la sección de
  // Implementación (placeholder "Iniciativa 1") — se reordenan en código
  // luego de agregar las tareas custom de la iniciativa: Tickets queda justo
  // después de la primera tarea custom, y el hito queda al final de todas.
  // "Ejecución" se borró de la plantilla directamente (ya no existe).
  iniciativa_tickets_task_name: 'Tickets',
  iniciativa_hito_task_name: 'Salida a producción',

  // GIDs de los campos custom a nivel de PROYECTO (Overview), no de tarea.
  fields: {
    atom_id:            '1210444217947526', // "Atom ID" (text)
    attio_company_id:   '1213632895496591', // "Attio Company ID" (text)
    url_attio:           '1214246840300235', // "URL Attio" (text)
    // El campo original "Iniciativa" (1219371735422810) se borró — se
    // reemplazó por "Iniciativas" (plural), un catálogo ya existente y usado
    // en otros proyectos del workspace (Cortex, WhatsApp Flows, Atomic,
    // Integraciones, etc.), asociado por el usuario al portfolio del cliente
    // el 2026-10-14.
    iniciativa:          '1219421576612465', // "Iniciativas" (multi_enum)
    ciclo_de_vida:       '1210562547163309', // "Ciclo de vida" (enum)
    plan_contratado:     '1212945918780798', // "Plan contratado" (enum)
    total_mrr:           '1214622504155723', // "Total MRR" (number)
    industria:           '1209758682431708', // "Industria" (enum)
    pais:                '1209758683683903', // "País" (enum)
    estado:              '1213128010621923', // "Estado" (enum)
  },

  // Portfolio "Clientes" (master) — cada cliente tiene su propia carpeta
  // (sub-portfolio) ahí dentro, y el proyecto CSM recién creado se agrega
  // como ítem de esa carpeta. Mismos GIDs de campo que arriba (se reusan
  // entre proyectos y portfolios) — ver update-clientes-portfolio.js, que ya
  // tenía esta lógica para ONB/Tickets, replicada acá para CSM (2026-10-13).
  clientes_portfolio_gid: '1213481895234783',
  ciclo_de_vida_cliente_option_gid: '1210562547163312', // opción "Cliente" del campo Ciclo de vida
};

// ─── Attio ────────────────────────────────────────────────────────────────────

export const ATTIO = {
  // Slugs de atributos en el objeto Onboarding
  onboarding: {
    owner:      'propietario_onboarding',
    company:    'company',    // TODO: verificar slug del atributo de asociación a Company
    deal:       'deal',       // TODO: verificar slug del atributo de asociación a Deal
    industry:   'industria',
    country:    'primary_location',
  },

  // Slugs de atributos en el objeto Deal
  deal: {
    name:         'name',
    mrr:          'mrr',         // TODO: verificar slug exacto
    owner_email:  'owner',       // TODO: verificar slug del owner en Deal
    partner:      'partner',     // Asociación con Partner
    sow_url:      'link_de_sow',
    baseline_url: 'i_link_del_baseline_y_roi',
  },

  // URL base para construir el link al onboarding en Attio
  onboarding_url: (recordId) =>
    `https://app.attio.com/atomchat/custom/onboardings/record/${recordId}/overview`,
};
