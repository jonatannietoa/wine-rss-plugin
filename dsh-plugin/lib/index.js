/**
 * Plugin de dsh del agente de catálogo: el adaptador primario.
 *
 * Este fichero es SOLO cableado. Define las herramientas que ve el modelo
 * —parámetros, esquema de salida y cómo se presenta el resultado— y llama a la
 * capa de aplicación de cada una. Cero lógica de negocio: si aquí hay una regla
 * de la tienda, está en el sitio equivocado.
 *
 * Cada tool es su propio hexágono, con su infraestructura de entrada y salida:
 *
 *     domain/product.js              el único dominio compartido entre tools
 *     catalog-load/                  infra (CSV, catalog.json) + application
 *     catalog-describe/              su propio dominio (ficha SEO), infra (LLM,
 *                                    almacenes) + application
 *     catalog-review/                application sobre el almacén de fichas
 *
 * Lo que es de la tienda —qué fichero se lee, cómo se llaman sus columnas, cómo
 * se traduce su taxonomía, con qué tono se escribe— vive en `catalog.config.yml`,
 * cuya ruta llega en `configPath` desde la fila del preset.
 *
 * @module dsh-plugin-catalog-agent
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { loadConfig } from './config.js'
import { DRAFT_SCHEMA, PRODUCT_SCHEMA, nulable, recuento } from './schemas.js'
import { loadCatalog } from './catalog-load/application/load-catalog.js'
import { listCatalogSources } from './catalog-load/application/list-sources.js'
import { describeCatalog } from './catalog-describe/application/describe-catalog.js'
import { readSeo, reviewCatalog } from './catalog-review/application/review-catalog.js'

export const name = 'catalog-agent'
// `llm` es el modelo de la sesión: `catalog_describe` redacta con el que el
// usuario haya elegido en dsh, en vez de traerse un cliente y una clave propios.
export const inject = ['tools', 'llm']

export const Config = z.object({
  configPath: z.string().required(),
})

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
      const dominio = loadConfig(config.configPath)
      return loadCatalog(dominio, args)
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
      'Lista los ficheros de catálogo que hay en las bandejas de entrada de la tienda, con cuántas filas '
      + 'traen y si su cabecera encaja con el mapeo de columnas configurado. Úsala cuando el usuario '
      + 'quiera cargar «otro» fichero, o no sepa cuál hay, o cuando te dé un nombre que no encuentres: '
      + 'así elige sobre lo que existe de verdad en vez de teclear una ruta a ciegas. Para cargar uno, '
      + 'pásale su nombre a catalog_load en `path`. Si el fichero que busca el usuario no aparece, es que '
      + 'está fuera de estas carpetas: pídele la ruta, o que lo mueva a una de ellas.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dirs: {
            type: 'array',
            required: true,
            description: 'Las bandejas configuradas, y si existen en disco.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                dir: { type: 'string', required: true },
                existe: { type: 'boolean', required: true },
              },
            },
          },
          habitual: { type: 'string', required: true, description: 'El catálogo que se carga si no se pide otro.' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                dir: { type: 'string', required: true },
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
        if (value.files.length === 0) {
          const sinCrear = value.dirs.filter((d) => !d.existe).map((d) => d.dir)
          partes.push(
            'No hay ningún fichero en las bandejas de entrada'
            + `${value.dirs.length > 0 ? `: ${value.dirs.map((d) => d.dir).join(', ')}` : ' (ninguna configurada)'}.`
            + `${sinCrear.length > 0 ? ` Sin crear todavía: ${sinCrear.join(', ')}.` : ''}`,
          )
        } else {
          for (const { dir } of value.dirs) {
            const suyos = value.files.filter((f) => f.dir === dir)
            if (suyos.length === 0) continue
            partes.push(
              `En ${dir}:\n` + suyos
                .map((f) => `  ${f.compatible ? '✓' : '✗'} ${f.name}`
                  + `${f.rows === null ? '' : ` — ${f.rows} filas`}`
                  + ` — modificado ${f.modifiedAt}`
                  + `${f.problema ? `\n      ${f.problema}` : ''}`)
                .join('\n'),
            )
          }
        }
        partes.push(`El catálogo habitual de la tienda, si no se pide otro, es ${value.habitual}.`)
        return [{ type: 'text', text: partes.join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      return listCatalogSources(loadConfig(config.configPath))
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
      reasoningEffort: {
        type: 'string',
        description:
          'Pisa `description.reasoningEffort` solo en esta llamada, para poder medir un valor contra '
          + 'otro sobre los mismos productos (con `regenerate: "always"`) y comparar '
          + '`segundosPorLlamada` e `intentosMedios`. DeepSeek acepta off, low, high y max. '
          + 'Úsalo para medir, no por gusto: lo normal es lo que diga la configuración.',
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
          cortado: {
            type: 'integer',
            required: true,
            description: 'Productos que no se intentaron porque el fallo era del modelo, no de los datos.',
          },
          llamadas: { type: 'integer', required: true, description: 'Llamadas al modelo que ha costado el lote.' },
          segundos: { type: 'number', required: true, description: 'Lo que ha tardado el lote de pared.' },
          razonamientoMaximo: {
            type: 'integer',
            required: true,
            description: 'Caracteres de razonamiento de la llamada que más razonó. Si se acerca a description.maxTokens × 3, el presupuesto va al filo y habrá respuestas vacías.',
          },
          segundosPorLlamada: {
            type: 'number',
            required: true,
            description: 'Media por llamada al modelo. Es la latencia del proveedor: no baja paralelizando, solo cambiando de modelo.',
          },
          esfuerzo: { type: 'string', required: true, description: 'Esfuerzo de razonamiento con el que se ha redactado.' },
          maxTokensConfigurado: { type: 'integer', required: true, description: 'El presupuesto por llamada, para poder compararlo con lo que se razonó.' },
          sonda: {
            type: 'boolean',
            required: true,
            description: 'Si el primer producto se ha redactado solo antes de paralelizar el resto.',
          },
          intentosMedios: {
            type: 'number',
            required: true,
            description: 'Intentos por ficha escrita. Cerca de 1 es lo bueno; cerca de 3 significa que el modelo pelea con las reglas.',
          },
          rechazos: {
            type: 'array',
            required: true,
            description: 'Qué reglas han rechazado borradores y cuántas veces. Es lo que dice qué optimizar.',
            items: recuento('code'),
          },
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
                caracteresTexto: { type: 'integer', required: true, description: 'Cuánto texto devolvió el modelo en el último intento.' },
                caracteresRazonamiento: { type: 'integer', required: true, description: 'Cuánto razonó. Mucho aquí y cero arriba significa presupuesto agotado pensando.' },
                respuestaCruda: { type: 'string', required: true, description: 'El principio de lo que devolvió, para poder verlo.' },
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
          `${value.generados} de ${value.solicitados} fichas escritas con ${value.modelo}`
          + ` en ${value.segundos}s`
          + ` y ${value.llamadas} ${value.llamadas === 1 ? 'llamada' : 'llamadas'} al modelo`
          + `${value.intentosMedios > 0 ? ` (${value.intentosMedios} intentos por ficha)` : ''}.`
          + `${value.fallidos > 0 ? ` ${value.fallidos} no pasaron la validación.` : ''}`,
          `Cada llamada tarda ${value.segundosPorLlamada}s de media con razonamiento "${value.esfuerzo}":`
          + ' eso es latencia del proveedor y no baja paralelizando.'
          + `${value.razonamientoMaximo > 0 ? ` La llamada que más razonó gastó ${value.razonamientoMaximo} caracteres en ello, de un presupuesto de ${value.maxTokensConfigurado} tokens.` : ''}`
          + `${value.sonda ? ' El primer producto ha ido solo (sonda de configuración), lo que cuesta una ronda entera; en la siguiente carga con este mismo modelo ya no hará falta.' : ''}`,
          `Del catálogo cargado desde ${value.sourcePath}.`
          + ` Quedan ${value.pendientes} productos sin ficha. Sin revisar: ${value.sinRevisar}.`,
          `Guardado en ${value.outputPath}`,
        ]
        if (value.cortado > 0) {
          partes.push(
            `He parado el lote: el primer producto falló sin que el modelo escribiera un solo bloque, `
            + `así que el problema no es de los datos. Quedan ${value.cortado} sin intentar, y así se `
            + 'ahorran otras tantas llamadas. Arregla lo de abajo y vuelve a lanzarlo.',
          )
        }
        if (value.fallos.length > 0) {
          partes.push('No pasaron la validación:\n' + value.fallos
            .map((f) => `  ${f.sku} (devolvió ${f.caracteresTexto} caracteres de texto`
              + `${f.caracteresRazonamiento > 0 ? ` y ${f.caracteresRazonamiento} de razonamiento` : ''}):\n`
              + f.problemas.map((p) => `    - ${p}`).join('\n')
              + `${f.respuestaCruda ? `\n    respuesta: "${f.respuestaCruda.slice(0, 200)}…"` : ''}`)
            .join('\n'))
        }
        if (value.rechazos.length > 0 && value.intentosMedios > 1.2) {
          partes.push(
            'Reglas que están costando llamadas:\n'
            + value.rechazos.map((r) => `  ${r.code}: ${r.count}`).join('\n')
            + '\nSi una domina, o se ajusta esa regla en `catalog.config.yml` o el modelo no la sigue bien.',
          )
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
      return describeCatalog(ctx, dominio, args, exec, name)
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
    name: 'catalog_seo',
    description:
      'Devuelve las fichas SEO ya escritas, para poder leerlas. Úsala para enseñárselas al usuario '
      + 'antes de que apruebe nada con catalog_review —aprobar sin ver es justo lo que la política de '
      + 'contenido generado prohíbe— y para comparar dos formas de generarlas. `catalog_describe` solo '
      + 'devuelve una de muestra, así que esta es la manera de ver el resto.',
    parameters: {
      sku: { type: 'string', description: 'Una ficha concreta.' },
      skus: { type: 'array', items: { type: 'string' }, description: 'Varias fichas concretas.' },
      limit: { type: 'integer', description: 'Las N primeras. Por defecto 4, para no llenar el contexto.' },
      soloSinRevisar: { type: 'boolean', description: 'Solo las que nadie ha revisado todavía.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          total: { type: 'integer', required: true, description: 'Fichas guardadas en total.' },
          sinRevisar: { type: 'integer', required: true },
          fichas: { type: 'array', required: true, items: DRAFT_SCHEMA },
          noEncontrados: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) {
          return [{ type: 'text', text: `No hay ninguna ficha escrita todavía (${value.outputPath}).` }]
        }
        const partes = [`${value.total} fichas guardadas, ${value.sinRevisar} sin revisar.`]
        for (const f of value.fichas) {
          partes.push(
            `${f.sku} — ${f.reviewed ? 'revisada' : 'SIN revisar'} · ${f.attempts} `
            + `${f.attempts === 1 ? 'intento' : 'intentos'} · ${f.model}\n`
            + `  seoTitle (${f.seoTitle.length}): ${f.seoTitle}\n`
            + `  seoDescription (${f.seoDescription.length}): ${f.seoDescription}\n`
            + `  handle: ${f.handle}\n`
            + `  altText: ${f.altText}\n`
            + `  bodyHtml: ${f.bodyHtml}\n`
            + `  feedDescription: ${f.feedDescription}`,
          )
        }
        if (value.noEncontrados.length > 0) {
          partes.push(`Sin ficha: ${value.noEncontrados.join(', ')}`)
        }
        return [{ type: 'text', text: partes.join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return readSeo(loadConfig(config.configPath), args)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.sku ? `Ver la ficha ${args.sku}` : 'Ver las fichas SEO escritas',
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
      return reviewCatalog(loadConfig(config.configPath), args)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.all ? 'Aprobar todas las fichas' : `Aprobar ficha${args.skus ? 's' : ''} ${args.sku ?? (args.skus ?? []).join(', ')}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
