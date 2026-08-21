/**
 * Plugin de dsh del agente de catálogo.
 *
 * Registra las herramientas del pipeline de catálogo en el registro `tools` del
 * host. De las cinco etapas están las tres primeras: `catalog_load` lee el
 * fichero del ERP y lo convierte en los objetos de producto del dominio, y
 * `catalog_describe` les escribe los textos SEO con el modelo de la sesión.
 * `catalog_review` es la puerta de revisión humana que pide la política de
 * contenido generado: nada se publica sin pasar por ella.
 *
 * El plugin no sabe nada de la tienda: qué fichero se lee, cómo se llaman sus
 * columnas y cómo se traduce su taxonomía lo declara `catalog.config.yml`, cuya
 * ruta llega en `configPath` desde la fila del preset. Cambiar de cliente, de ERP
 * o de vertical es cambiar ese fichero, no este código.
 *
 * @module dsh-plugin-catalog-agent
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { buildCatalog, listSources, loadConfig, resolveFromConfig } from './catalog.js'
import { SEO_FIELDS, buildPrompt, parseDraft, validateDraft } from './seo.js'

export const name = 'catalog-agent'
// `llm` es el modelo de la sesión: `catalog_describe` redacta con el que el
// usuario haya elegido en dsh, en vez de traerse un cliente y una clave propios.
export const inject = ['tools', 'llm']

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

/** Una ficha SEO ya generada, tal como se guarda y se publica. */
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

/** Cuántos textos SEO caben en la respuesta del modelo, con margen. */
const MAX_TOKENS_FICHA = 1500

/**
 * Lee el almacén de textos SEO. No existir es lo normal la primera vez.
 * @param path - ruta del JSON.
 * @returns las fichas indexadas por SKU.
 */
function cargarSeo(path) {
  if (!existsSync(path)) return {}
  let datos
  try {
    datos = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer ${path}: ${error.message}`)
  }
  return datos?.items && typeof datos.items === 'object' ? datos.items : {}
}

/**
 * Guarda el almacén de textos SEO.
 * @param path - ruta del JSON.
 * @param items - las fichas indexadas por SKU.
 */
function guardarSeo(path, items) {
  mkdirSync(dirname(path), { recursive: true })
  const contenido = { generatedAt: new Date().toISOString(), items }
  writeFileSync(path, `${JSON.stringify(contenido, null, 2)}\n`, 'utf8')
}

/** Resuelve la ruta del almacén SEO declarada en la configuración. */
const rutaSeo = (dominio) =>
  resolveFromConfig(dominio, dominio.output?.seoJson ?? './.artifacts/catalog-seo.json')

/**
 * El catálogo que dejó la última carga.
 *
 * Las etapas 3, 4 y 5 consumen la salida de la 2, no el fichero de entrada: así
 * describen lo que el usuario cargó de verdad, aunque no sea el habitual.
 * @param dominio - la configuración cargada.
 * @returns el catálogo con sus productos.
 */
function cargarCatalogo(dominio) {
  const path = resolveFromConfig(dominio, dominio.output?.catalogJson ?? './.artifacts/catalog.json')
  if (!existsSync(path)) {
    throw new Error(
      `no hay catálogo cargado (falta ${path}). Llama antes a catalog_load, y si el usuario quiere `
      + 'un fichero concreto, pásale su nombre en `path`.',
    )
  }
  let datos
  try {
    datos = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`no se pudo leer el catálogo cargado en ${path}: ${error.message}`)
  }
  if (!Array.isArray(datos?.items)) throw new Error(`${path} no tiene una lista de productos`)
  return datos
}

/**
 * Los handles y los textos que ya están en uso, para que dos fichas no salgan
 * iguales ni compartan URL.
 * @param items - las fichas ya generadas.
 * @param excluir - SKUs que se están regenerando y por tanto no cuentan.
 * @returns `{ handles, textos }`.
 */
function yaUsados(items, excluir = new Set()) {
  const handles = new Set()
  const textos = new Set()
  for (const [sku, ficha] of Object.entries(items)) {
    if (excluir.has(sku)) continue
    if (ficha.handle) handles.add(ficha.handle)
    for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
      if (ficha[campo]) textos.add(`${campo}:${ficha[campo]}`)
    }
  }
  return { handles, textos }
}

/**
 * Pide al modelo de la sesión los textos de un producto y no se da por
 * satisfecho hasta que pasan la validación.
 *
 * El bucle de reintentos está aquí y no en el agente a propósito: son cientos de
 * productos, y meter cada corrección en la conversación llenaría el contexto.
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param modelo - `{ provider, model }` de la sesión.
 * @param product - el producto normalizado.
 * @param dominio - la configuración cargada.
 * @param usados - handles y textos ya en uso.
 * @param signal - la señal de cancelación del tool.
 * @returns `{ draft }` si pasó, o `{ problemas }` con lo que falló en el último intento.
 */
async function redactar(ctx, modelo, product, dominio, usados, signal) {
  const maxIntentos = dominio.description?.maxAttempts ?? 3
  let problemas = []

  for (let intento = 1; intento <= maxIntentos; intento += 1) {
    const { system, user } = buildPrompt(product, dominio, problemas)
    let texto = ''
    for await (const trozo of ctx.llm.stream({
      provider: modelo.provider,
      model: modelo.model,
      system,
      messages: [createUserMessage({
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: name, contextForm: 'transient' },
      })],
      maxTokens: MAX_TOKENS_FICHA,
      signal,
    })) {
      if (trozo.type === 'text-delta') texto += trozo.text
    }

    let draft
    try {
      draft = parseDraft(texto)
    } catch (error) {
      problemas = [error.message, 'Devuelve SOLO el objeto JSON, sin ningún texto alrededor.']
      continue
    }

    problemas = validateDraft(draft, product, dominio, usados)
    if (problemas.length === 0) {
      return {
        draft: {
          sku: product.sku,
          ...Object.fromEntries(SEO_FIELDS.map((campo) => [campo, draft[campo]])),
          reviewed: false,
          generatedAt: new Date().toISOString(),
          model: `${modelo.provider}/${modelo.model}`,
          attempts: intento,
        },
      }
    }
  }

  return { problemas }
}

/**
 * Pinta el resumen para el modelo. Deliberadamente en texto y acotado: el
 * catálogo entero vive en el fichero, no en el contexto.
 * @param value - el resumen que devolvió el tool.
 * @returns las líneas del informe.
 */
function informe(value) {
  const partes = [
    `Catálogo cargado desde ${value.sourcePath}: ${value.ok} productos de ${value.total} filas.`
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
          'Fichero a leer, en vez del catálogo habitual de la tienda. Basta el nombre si está en la '
          + 'bandeja de entrada (usa catalog_sources para ver qué hay); también vale una ruta '
          + 'relativa al directorio de la sesión, o absoluta. Omítelo para el catálogo de la tienda.',
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
          sourcePath: { type: 'string', required: true, description: 'El fichero que se ha leído.' },
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
        // La resolución la hace `resolveSourcePath`: nombre suelto en la bandeja
        // de entrada, relativa contra el directorio de la sesión, absoluta tal cual.
        path: args.path?.trim() || undefined,
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

      return { outputPath, sourcePath: catalog.source.path, ...summary, producto }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.sku ? `Cargar catálogo (producto ${args.sku})` : 'Cargar catálogo de la tienda',
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'catalog_sources',
    description:
      'Lista los ficheros de catálogo que hay en la bandeja de entrada de la tienda, con cuántas filas '
      + 'traen y si su cabecera encaja con el mapeo de columnas configurado. Úsala cuando el usuario '
      + 'quiera cargar «otro» fichero, o no sepa cuál hay, o cuando te dé un nombre que no encuentres: '
      + 'así elige sobre lo que existe de verdad en vez de teclear una ruta a ciegas. Para cargar uno, '
      + 'pásale su nombre a catalog_load en `path`.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { ...nulable('string'), required: true, description: 'La bandeja de entrada configurada.' },
          existe: { type: 'boolean', required: true, description: 'Si ese directorio existe.' },
          habitual: { type: 'string', required: true, description: 'El catálogo que se carga si no se pide otro.' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                modifiedAt: { type: 'string', required: true },
                rows: { ...nulable('integer'), required: true },
                compatible: { type: 'boolean', required: true },
                problema: { ...nulable('string'), required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const partes = []
        if (!value.existe) {
          partes.push(
            `La bandeja de entrada (${value.dir ?? 'sin configurar'}) no existe todavía. Créala y deja ahí `
            + 'los ficheros que quieras cargar.',
          )
        } else if (value.files.length === 0) {
          partes.push(`No hay ningún fichero en la bandeja de entrada (${value.dir}).`)
        } else {
          partes.push(
            `En ${value.dir}:\n` + value.files
              .map((f) => `  ${f.compatible ? '✓' : '✗'} ${f.name}`
                + `${f.rows === null ? '' : ` — ${f.rows} filas`}`
                + ` — modificado ${f.modifiedAt}`
                + `${f.problema ? `\n      ${f.problema}` : ''}`)
              .join('\n'),
          )
        }
        partes.push(`El catálogo habitual de la tienda, si no se pide otro, es ${value.habitual}.`)
        return [{ type: 'text', text: partes.join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const dominio = loadConfig(config.configPath)
      const { dir, existe, files } = listSources(dominio)
      return {
        dir,
        existe,
        habitual: resolveFromConfig(dominio, dominio.source.path),
        files,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Ver los catálogos disponibles', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'catalog_describe',
    description:
      'Escribe los textos SEO de los productos del catálogo con el modelo de esta sesión: meta title, '
      + 'meta description, la descripción de la ficha (párrafo corto + bullets escaneables), el handle de '
      + 'la URL, el texto alternativo de la foto y la descripción para el feed de Google Merchant Center. '
      + 'Valida cada borrador —longitudes, keyword stuffing, lenguaje promocional, datos inventados, '
      + 'duplicados entre fichas— y hace que el modelo se corrija si falla. Hay que acotar cuántos '
      + 'productos: sin `sku`, `skus` ni `limit` no procesa nada, porque el catálogo tiene cientos y cada '
      + 'uno es una llamada al modelo. Las fichas nacen SIN revisar: usa catalog_review para aprobarlas.',
    parameters: {
      sku: { type: 'string', description: 'Un solo producto, por su SKU.' },
      skus: {
        type: 'array',
        items: { type: 'string' },
        description: 'Varios productos concretos, por SKU.',
      },
      limit: {
        type: 'integer',
        description:
          'Cuántos de los que están pendientes procesar, empezando por el principio del catálogo. '
          + 'Es la forma normal de ir por lotes.',
      },
      regenerate: {
        type: 'string',
        enum: ['missing', 'always'],
        description:
          '`missing` (lo normal) solo escribe los que no tienen ficha todavía; `always` rescribe también '
          + 'los que ya la tienen, perdiendo el texto anterior. Por defecto, lo que diga la configuración.',
      },
      dryRun: {
        type: 'boolean',
        description:
          'No llama al modelo: devuelve el prompt que se le enviaría para el primer producto del lote. '
          + 'Úsalo para revisar las instrucciones antes de gastar llamadas.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          sourcePath: { type: 'string', required: true, description: 'El fichero del que salió el catálogo cargado.' },
          modelo: { type: 'string', required: true, description: 'El modelo de la sesión que ha redactado.' },
          solicitados: { type: 'integer', required: true },
          generados: { type: 'integer', required: true },
          fallidos: { type: 'integer', required: true },
          pendientes: { type: 'integer', required: true, description: 'Productos del catálogo que siguen sin ficha.' },
          sinRevisar: { type: 'integer', required: true, description: 'Fichas generadas que nadie ha revisado aún.' },
          fallos: {
            type: 'array',
            required: true,
            description: 'Productos cuyos borradores no pasaron la validación, con lo que falló en el último intento.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sku: { type: 'string', required: true },
                problemas: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          muestra: { type: 'array', required: true, items: DRAFT_SCHEMA },
          prompt: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  system: { type: 'string', required: true },
                  user: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
      render: (_args, value) => {
        if (value.prompt) {
          return [{
            type: 'text',
            text: `Prueba en seco, no se ha llamado al modelo.\n\n--- instrucciones ---\n${value.prompt.system}`
              + `\n\n--- producto ---\n${value.prompt.user}`,
          }]
        }
        const partes = [
          `${value.generados} de ${value.solicitados} fichas escritas con ${value.modelo}.`
          + `${value.fallidos > 0 ? ` ${value.fallidos} no pasaron la validación.` : ''}`,
          `Del catálogo cargado desde ${value.sourcePath}.`
          + ` Quedan ${value.pendientes} productos sin ficha. Sin revisar: ${value.sinRevisar}.`,
          `Guardado en ${value.outputPath}`,
        ]
        if (value.fallos.length > 0) {
          partes.push('No pasaron la validación:\n' + value.fallos
            .map((f) => `  ${f.sku}:\n${f.problemas.map((p) => `    - ${p}`).join('\n')}`)
            .join('\n'))
        }
        if (value.muestra.length > 0) {
          const ficha = value.muestra[0]
          partes.push(
            `Así ha quedado ${ficha.sku} (${ficha.attempts} ${ficha.attempts === 1 ? 'intento' : 'intentos'}):\n`
            + `  seoTitle (${ficha.seoTitle.length}): ${ficha.seoTitle}\n`
            + `  seoDescription (${ficha.seoDescription.length}): ${ficha.seoDescription}\n`
            + `  handle: ${ficha.handle}\n`
            + `  altText: ${ficha.altText}\n`
            + `  bodyHtml: ${ficha.bodyHtml}\n`
            + `  feedDescription: ${ficha.feedDescription}`,
          )
        }
        partes.push('Ninguna ficha se publica sin pasar por catalog_review.')
        return [{ type: 'text', text: partes.join('\n\n') }]
      },
    },
    // Escribe el mismo fichero y consume cuota del modelo: dos a la vez se pisan.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const dominio = loadConfig(config.configPath)
      // El catálogo sale del JSON que dejó `catalog_load`, no de releer el fichero
      // configurado: si el usuario cargó otro, es ese el que hay que describir.
      const catalog = cargarCatalogo(dominio)
      const porSku = new Map(catalog.items.map((item) => [item.sku, item]))
      const salida = rutaSeo(dominio)
      const fichas = cargarSeo(salida)

      const politica = args.regenerate ?? dominio.description?.regenerate ?? 'missing'
      if (politica === 'never') {
        throw new Error('la configuración dice `description.regenerate: never`: no se escribe ninguna ficha')
      }
      const pendientes = catalog.items.filter((item) => politica === 'always' || !fichas[item.sku])

      let objetivo
      const pedidos = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
      if (pedidos.length > 0) {
        const desconocidos = pedidos.filter((sku) => !porSku.has(sku))
        if (desconocidos.length > 0) {
          throw new Error(`estos SKU no están en el catálogo: ${desconocidos.join(', ')}`)
        }
        objetivo = pedidos.map((sku) => porSku.get(sku))
      } else if (args.limit) {
        if (args.limit < 1) throw new Error(`limit tiene que ser 1 o más (recibido ${args.limit})`)
        objetivo = pendientes.slice(0, args.limit)
      } else {
        throw new Error(
          `hay ${pendientes.length} productos sin ficha de ${catalog.items.length} del catálogo, y cada uno es `
          + 'una llamada al modelo. Acota el lote: `limit` para procesar los N primeros pendientes, o `sku`/`skus` '
          + 'para productos concretos.',
        )
      }

      const techo = dominio.description?.maxPerCall ?? 50
      if (objetivo.length > techo) {
        throw new Error(
          `has pedido ${objetivo.length} productos y el techo por llamada es ${techo} `
          + '(`description.maxPerCall`). Ve por lotes.',
        )
      }
      if (objetivo.length === 0) {
        throw new Error('no hay ningún producto pendiente: todos tienen ficha ya. Usa `regenerate: always` para rescribir.')
      }

      const usados = yaUsados(fichas, new Set(objetivo.map((item) => item.sku)))

      if (args.dryRun) {
        return {
          outputPath: salida,
          sourcePath: catalog.source?.path ?? '(desconocido)',
          modelo: '(prueba en seco: no se ha llamado a ninguno)',
          solicitados: objetivo.length,
          generados: 0,
          fallidos: 0,
          pendientes: pendientes.length,
          sinRevisar: Object.values(fichas).filter((f) => !f.reviewed).length,
          fallos: [],
          muestra: [],
          prompt: buildPrompt(objetivo[0], dominio),
        }
      }

      const opciones = exec.agent?.options
      if (!opciones?.provider || !opciones?.model) {
        throw new Error(
          'no se ha podido averiguar el modelo de esta sesión, así que no hay con qué redactar. '
          + 'Esta herramienta usa el modelo del agente: revisa la configuración del host.',
        )
      }
      const modelo = { provider: opciones.provider, model: opciones.model }

      const generadas = []
      const fallos = []
      for (const product of objetivo) {
        exec.signal.throwIfAborted()
        const resultado = await redactar(ctx, modelo, product, dominio, usados, exec.signal)
        if (resultado.draft) {
          fichas[product.sku] = resultado.draft
          generadas.push(resultado.draft)
          usados.handles.add(resultado.draft.handle)
          for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
            usados.textos.add(`${campo}:${resultado.draft[campo]}`)
          }
        } else {
          fallos.push({ sku: product.sku, problemas: resultado.problemas })
        }
      }
      guardarSeo(salida, fichas)

      return {
        outputPath: salida,
        sourcePath: catalog.source?.path ?? '(desconocido)',
        modelo: `${modelo.provider}/${modelo.model}`,
        solicitados: objetivo.length,
        generados: generadas.length,
        fallidos: fallos.length,
        pendientes: catalog.items.filter((item) => !fichas[item.sku]).length,
        sinRevisar: Object.values(fichas).filter((ficha) => !ficha.reviewed).length,
        fallos: fallos.slice(0, 5),
        muestra: generadas.slice(0, 1),
        prompt: null,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.dryRun
        ? 'Ver el prompt de las descripciones'
        : `Escribir fichas SEO${args.sku ? ` (${args.sku})` : args.limit ? ` (${args.limit})` : ''}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'catalog_review',
    description:
      'Marca fichas SEO como revisadas por una persona. Es la puerta que exige la política de contenido '
      + 'generado con IA: lo que no pase por aquí no se publica en la tienda. Llámala DESPUÉS de haberle '
      + 'enseñado al usuario los textos y de que él los haya aprobado; no apruebes tú lo que has escrito tú.',
    parameters: {
      sku: { type: 'string', description: 'Una ficha concreta.' },
      skus: { type: 'array', items: { type: 'string' }, description: 'Varias fichas concretas.' },
      all: {
        type: 'boolean',
        description:
          'Marca como revisadas TODAS las fichas pendientes. Solo si el usuario lo ha pedido explícitamente '
          + 'después de verlas: aprobar a ciegas es justo lo que la política de contenido generado prohíbe.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          revisadas: { type: 'integer', required: true },
          yaEstaban: { type: 'integer', required: true },
          sinRevisar: { type: 'integer', required: true },
          sinFicha: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const partes = [
          `${value.revisadas} fichas marcadas como revisadas.`
          + `${value.yaEstaban > 0 ? ` ${value.yaEstaban} ya lo estaban.` : ''}`,
          `Quedan ${value.sinRevisar} sin revisar.`,
        ]
        if (value.sinFicha.length > 0) {
          partes.push(`Estos SKU no tienen ficha que revisar: ${value.sinFicha.join(', ')}`)
        }
        return [{ type: 'text', text: partes.join(' ') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const dominio = loadConfig(config.configPath)
      const salida = rutaSeo(dominio)
      const fichas = cargarSeo(salida)

      const pedidos = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
      if (pedidos.length === 0 && !args.all) {
        throw new Error('di qué revisar: `sku`, `skus`, o `all: true` para todas las pendientes')
      }

      const objetivo = args.all ? Object.keys(fichas) : pedidos
      const sinFicha = objetivo.filter((sku) => !fichas[sku])
      let revisadas = 0
      let yaEstaban = 0
      for (const sku of objetivo) {
        const ficha = fichas[sku]
        if (!ficha) continue
        if (ficha.reviewed) yaEstaban += 1
        else {
          ficha.reviewed = true
          revisadas += 1
        }
      }
      guardarSeo(salida, fichas)

      return {
        outputPath: salida,
        revisadas,
        yaEstaban,
        sinRevisar: Object.values(fichas).filter((ficha) => !ficha.reviewed).length,
        sinFicha,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.all ? 'Aprobar todas las fichas' : `Aprobar ficha${args.skus ? 's' : ''} ${args.sku ?? (args.skus ?? []).join(', ')}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
