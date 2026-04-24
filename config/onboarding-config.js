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
