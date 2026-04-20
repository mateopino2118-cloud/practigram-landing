// Variantes disponibles para Practigram Landing.
// DEFAULT_ACTIVE: las 4 que entran al torneo desde el día 1.
// DEFAULT_QUEUE:  las siguientes 4 que entran cuando el torneo las llame.

const ALL_VARIANTS = [
  { id: 'v1', file: 'v1-carta-ventas',        name: 'Carta de Ventas' },
  { id: 'v2', file: 'v2-proof-wall',           name: 'Proof Wall' },
  { id: 'v3', file: 'v3-minimal-premium',      name: 'Minimal Premium' },
  { id: 'v4', file: 'v4-chat-conversacional',  name: 'Chat Conversacional' },
  { id: 'v5', file: 'v5-periodico',            name: 'Periodico' },
  { id: 'v6', file: 'v6-manifiesto',           name: 'Manifiesto' },
  { id: 'v7', file: 'v7-antes-despues',        name: 'Antes/Despues' },
  { id: 'v8', file: 'v8-quiz',                 name: 'Quiz Interactivo' },
  { id: 'v9', file: 'v9-vidriera',             name: 'Instagram Vidriera' },
  { id: 'vc', file: 'vc-clase-oficial',        name: 'Clase Oficial' },
];

const VALID_IDS  = ALL_VARIANTS.map(v => v.id);
const VARIANT_MAP = Object.fromEntries(ALL_VARIANTS.map(v => [v.id, v]));

const DEFAULT_ACTIVE = ['v1', 'v2', 'v3', 'v4'];
const DEFAULT_QUEUE  = ['v5', 'v6', 'v7', 'v8', 'v9'];

function getVariantById(id) { return VARIANT_MAP[id] || null; }
function getActiveVariants(config) {
  return (config.activeVariants || DEFAULT_ACTIVE).map(id => VARIANT_MAP[id]).filter(Boolean);
}

module.exports = { ALL_VARIANTS, VALID_IDS, VARIANT_MAP, DEFAULT_ACTIVE, DEFAULT_QUEUE, getVariantById, getActiveVariants };
