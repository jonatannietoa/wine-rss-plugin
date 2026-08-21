/**
 * Plugin de dsh del agente de catálogo.
 *
 * Registra las herramientas del pipeline de catálogo en el registro `tools` del
 * host. De las cinco etapas, aquí está la primera pieza: `catalog_load`, que lee
 * el fichero del ERP y lo convierte en los objetos de producto del dominio.
 *
 * El plugin no sabe nada de la tienda: qué fichero se lee, cómo se llaman sus
 * columnas y cómo se traduce su taxonomía lo declara `catalog.config.yml`, cuya
 * ruta llega en `configPath` desde la fila del preset. Cambiar de cliente, de ERP
 * o de vertical es cambiar ese fichero, no este código.
 *
 * @module dsh-plugin-catalog-agent
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildCatalog, loadConfig, resolveFromConfig } from './catalog.js'

export const name = 'catalog-agent'
export const inject = ['tools']

export const Config = z.object({
  configPath: z.string().required(),
})

/** Un campo del modelo que el fichero puede no traer. */
const nulable = (type) => ({ oneOf: [{ type }, { type: 'null' }] })

/** Recuento con nombre, para los histogramas del resumen. */
const recuento = (clave) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    [clave]: { type: 'string', required: true },
    count: { type: 'integer', required: true },
  },
})

/** El producto del modelo interno, tal como sale de la normalización. */
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

/**
 * Pinta el resumen para el modelo. Deliberadamente en texto y acotado: el
 * catálogo entero vive en el fichero, no en el contexto.
 * @param value - el resumen que devolvió el tool.
 * @returns las líneas del informe.
 */
function informe(value) {
  const partes = [
    `Catálogo cargado: ${value.ok} productos de ${value.total} filas.`
    + `${value.rechazados > 0 ? ` ${value.rechazados} filas rechazadas.` : ''}`
    + `${value.omitidosPorFecha > 0 ? ` ${value.omitidosPorFecha} sin cambios desde la fecha pedida.` : ''}`,
    `JSON completo en ${value.outputPath}`,
  ]

  if (value.porGrupo.length > 0) {
    partes.push(
      'Por tipo de producto:\n'
      + value.porGrupo.map((g) => `  ${g.productType}: ${g.count}`).join('\n'),
    )
  }
  if (value.avisos.length > 0) {
    partes.push('Avisos: ' + value.avisos.map((a) => `${a.code} (${a.count})`).join(', '))
  }
  if (value.columnasAusentes.length > 0) {
    partes.push(
      'Columnas declaradas en la configuración que el fichero NO trae: '
      + `${value.columnasAusentes.join(', ')}. Esos campos van vacíos en todos los productos.`,
    )
  }
  if (value.rechazos.length > 0) {
    partes.push(
      `Filas rechazadas${value.rechazados > value.rechazos.length ? ` (las ${value.rechazos.length} primeras de ${value.rechazados})` : ''}:\n`
      + value.rechazos.map((r) => `  línea ${r.row} ${r.sku ?? '(sin sku)'}: ${r.reason}`).join('\n'),
    )
  }
  if (value.producto) {
    partes.push(`Producto pedido:\n${JSON.stringify(value.producto, null, 2)}`)
  } else if (value.muestra.length > 0) {
    partes.push(`Muestra de cómo queda un producto:\n${JSON.stringify(value.muestra[0], null, 2)}`)
  }
  return partes.join('\n\n')
}

/**
 * Registra las herramientas del catálogo. Ninguna publica servicios, así que la
 * fila del preset va suelta y sin realm aislado.
 * @param ctx - el contexto Cordis de la fila.
 * @param config - la configuración validada por {@link Config}.
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'catalog_load',
    description:
      'Lee el fichero de catálogo de la tienda (el export del ERP) y lo convierte en los productos '
      + 'del dominio: SKU, nombre, formato, tipo de producto, tags, precio, coste y stock. Escribe el '
      + 'catálogo completo en un JSON y te devuelve un resumen con los totales, el desglose por tipo '
      + 'de producto y las filas que ha rechazado. Los productos NO caben en el resultado: para ver uno '
      + 'concreto vuelve a llamarla con su `sku`. Es el punto de partida de todo lo demás: para escribir '
      + 'descripciones, buscar imágenes o publicar en Shopify hace falta haber cargado el catálogo antes.',
    parameters: {
      path: {
        type: 'string',
        description:
          'Fichero alternativo a leer, en vez del que declara la configuración de la tienda. '
          + 'Si es relativo, cuelga del directorio de trabajo de la sesión. '
          + 'Úsalo solo si el usuario te da uno explícitamente.',
      },
      modifiedSince: {
        type: 'string',
        description:
          'Fecha `aaaa-mm-dd`. Procesa solo los productos que el ERP modificó a partir de ella, '
          + 'para una carga incremental. Omítelo para procesar el fichero entero, que es lo normal.',
      },
      sku: {
        type: 'string',
        description:
          'SKU de un producto concreto: lo devuelve normalizado en el campo `producto`, para poder '
          + 'comprobar cómo queda una ficha sin volcar el catálogo entero.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true, description: 'Dónde ha quedado el JSON completo.' },
          total: { type: 'integer', required: true, description: 'Filas leídas del fichero, sin contar la cabecera.' },
          ok: { type: 'integer', required: true, description: 'Productos publicables.' },
          rechazados: { type: 'integer', required: true },
          omitidosPorFecha: { type: 'integer', required: true },
          porGrupo: { type: 'array', required: true, items: recuento('productType') },
          avisos: { type: 'array', required: true, items: recuento('code') },
          columnasAusentes: { type: 'array', required: true, items: { type: 'string' } },
          rechazos: {
            type: 'array',
            required: true,
            description: 'Las primeras filas rechazadas, con el motivo. No están en el JSON de productos.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                row: { type: 'integer', required: true },
                sku: { ...nulable('string'), required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          muestra: { type: 'array', required: true, items: PRODUCT_SCHEMA },
          producto: { oneOf: [PRODUCT_SCHEMA, { type: 'null' }], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: informe(value) }],
    },
    // Escribe siempre el mismo fichero de salida, así que dos cargas en paralelo
    // se pisarían.
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.modifiedSince && !/^\d{4}-\d{2}-\d{2}$/.test(args.modifiedSince.trim())) {
        throw new Error(`modifiedSince debe ser una fecha aaaa-mm-dd (recibido "${args.modifiedSince}")`)
      }

      const dominio = loadConfig(config.configPath)
      const { catalog, summary } = buildCatalog(dominio, {
        // Una ruta que da el usuario se resuelve contra el directorio de trabajo
        // de la sesión; las que declara la configuración cuelgan del directorio
        // de la propia configuración.
        path: args.path?.trim() ? resolve(args.path.trim()) : undefined,
        modifiedSince: args.modifiedSince?.trim() || undefined,
      })

      const outputPath = resolveFromConfig(dominio, dominio.output?.catalogJson ?? './.artifacts/catalog.json')
      mkdirSync(dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

      let producto = null
      if (args.sku) {
        const buscado = args.sku.trim()
        producto = catalog.items.find((item) => item.sku === buscado) ?? null
        if (!producto) {
          const rechazado = catalog.rejected.find((fila) => fila.sku === buscado)
          throw new Error(rechazado
            ? `el sku "${buscado}" está en el fichero pero se ha rechazado (línea ${rechazado.row}): ${rechazado.reason}`
            : `el sku "${buscado}" no está en ${catalog.source.path}`)
        }
      }

      return { outputPath, ...summary, producto }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.sku ? `Cargar catálogo (producto ${args.sku})` : 'Cargar catálogo de la tienda',
      kind: 'other',
      rawInput: args,
    }),
  }))
}
