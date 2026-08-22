/**
 * Los esquemas de salida que comparten las tools, en el subconjunto de JSON
 * Schema que acepta dsh-tools.
 *
 * Son forma del adaptador primario, no del dominio: describen lo que ve el
 * modelo, no lo que es un producto.
 *
 * @module dsh-plugin-catalog-agent/schemas
 */

/** Un campo del modelo que el fichero puede no traer. */
export
const nulable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

/** Recuento con nombre, para los histogramas del resumen. */
export
const recuento = (clave) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    [clave]: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  },
})

/** El producto del modelo interno, tal como sale de la normalización. */
export
const PRODUCT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sku: { type: 'string', required: true },
    titleRaw: { type: 'string', required: true, description: 'El nombre tal cual lo manda el ERP.' },
    title: { type: 'string', required: true, description: 'El nombre ya capitalizado y sin el formato.' },
    format: { ...nulable('string'), required: true },
    volumeMl: { ...nulable('integer'), required: true },
    group: { type: 'string', required: true, description: 'El código de grupo del ERP.' },
    productType: { type: 'string', required: true, description: 'El tipo de producto legible con el que se categoriza en Shopify.' },
    category: { ...nulable('string'), required: true },
    origin: { ...nulable('string'), required: true },
    countryCode: { ...nulable('string'), required: true },
    productionType: { ...nulable('string'), required: true },
    tags: { type: 'array', required: true, items: { type: 'string' } },
    price: { type: 'number', required: true },
    cost: { ...nulable('number'), required: true },
    stock: { type: 'integer', required: true },
    blocked: { type: 'boolean', required: true },
    supplierCode: { ...nulable('string'), required: true },
    vendor: { ...nulable('string'), required: true },
    modifiedAt: { ...nulable('string'), required: true },
    warnings: {
      type: 'array',
      required: true,
      description: 'Lo que el fichero no dice de este producto. No impide publicarlo.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', required: true },
          field: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
    },
    row: { type: 'integer', required: true, description: 'La línea del fichero, para poder ir a mirarla.' },
  },
}

/** Una ficha SEO ya generada, tal como se guarda y se publica. */
export
const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sku: { type: 'string', required: true },
    seoTitle: { type: 'string', required: true, description: 'Meta title de la página.' },
    seoDescription: { type: 'string', required: true, description: 'Meta description del resultado de búsqueda.' },
    bodyHtml: { type: 'string', required: true, description: 'La descripción de la ficha: un párrafo y bullets.' },
    handle: { type: 'string', required: true, description: 'El trozo final de la URL.' },
    altText: { type: 'string', required: true, description: 'Texto alternativo de la foto.' },
    feedDescription: { type: 'string', required: true, description: 'Descripción para el feed de Merchant Center.' },
    reviewed: { type: 'boolean', required: true, description: 'Si una persona la ha revisado. Sin esto no se publica.' },
    generatedAt: { type: 'string', required: true },
    model: { type: 'string', required: true },
    attempts: { type: 'integer', required: true, description: 'Intentos que necesitó para pasar la validación.' },
  },
}
