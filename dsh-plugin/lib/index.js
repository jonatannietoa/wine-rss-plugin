import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Plugin de herramientas del agente de vinos para DeepSeek Harness.
 *
 * Es la versión nativa del agente Python de este repo: `RSSFeedTool` y `StockTool`
 * pasan a ser herramientas del registro `tools`, y la validación que hacía
 * `AgentLoop._validate` vive ahora en `wine_recommend`, que rechaza la llamada para
 * que el loop del harness se autocorrija en lugar de reintentar por su cuenta.
 * `ModelPlugin` desaparece: el modelo es el del propio harness.
 *
 * @module dsh-plugin-wine-agent
 */

export const name = 'wine-agent'
export const inject = ['tools']

export const Config = z.object({
  stockPath: z.string().required(),
  feedUrl: z.string().default('https://www.wine-searcher.com/rss-feed/dept/all'),
  timeoutMs: z.number().default(15000),
  maxItems: z.number().default(10),
  minResumenChars: z.number().default(20),
})

const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-plugin-wine-agent/0.1)'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * Convierte el contenido de un nodo RSS en texto plano legible: quita CDATA, marcado
 * y entidades, y colapsa los espacios. Wine-Searcher publica `description` con HTML.
 * @param raw - el contenido crudo del nodo.
 * @returns el texto plano ya normalizado.
 */
function toText(raw) {
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, entity) => ENTITIES[entity.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Lee el primer nodo presente de entre varios nombres dentro de un bloque `<item>`.
 * @param block - el XML del item.
 * @param names - nombres de nodo por orden de preferencia.
 * @returns el texto del primero que exista, o cadena vacía.
 */
function readTag(block, names) {
  for (const tag of names) {
    const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'))
    if (match) {
      const text = toText(match[1])
      if (text) return text
    }
  }
  return ''
}

/**
 * Extrae las noticias de un feed RSS 2.0. Deliberadamente tolerante: un feed sin
 * `<item>` devuelve una lista vacía y quien llama decide qué hacer.
 * @param xml - el cuerpo del feed.
 * @param limit - cuántas noticias conservar, de más reciente a más antigua.
 * @returns las noticias ya normalizadas.
 */
function parseFeed(xml, limit) {
  const items = []
  for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    if (items.length >= limit) break
    const block = match[1]
    items.push({
      titulo: readTag(block, ['title']),
      resumen: readTag(block, ['description', 'summary', 'content:encoded']),
      enlace: readTag(block, ['link', 'guid']),
      publicado: readTag(block, ['pubDate', 'published', 'updated']),
    })
  }
  return items
}

/**
 * Carga el catálogo de la tienda desde disco en cada llamada, para que editar
 * `stock.json` se note sin reiniciar el harness.
 * @param stockPath - ruta absoluta del catálogo.
 * @param signal - señal de cancelación del propio tool.
 * @returns la lista de vinos.
 */
async function loadStock(stockPath, signal) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(stockPath, { encoding: 'utf8', signal }))
  } catch (error) {
    throw new Error(`no se pudo leer el stock en ${stockPath}: ${error.message}`)
  }
  if (!Array.isArray(parsed)) throw new Error(`el stock en ${stockPath} debe ser una lista de vinos`)
  return parsed
}

/** El esquema de un vino del catálogo; abierto, para que añadir columnas no rompa la herramienta. */
const WINE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    product_id: { type: 'string', required: true },
    nombre: { type: 'string', required: true },
    region: { type: 'string' },
    uva: { type: 'string' },
    tipo: { type: 'string' },
    precio_eur: { type: 'number' },
    stock: { type: 'number' },
  },
}

/**
 * Registra las tres herramientas del agente de vinos en el registro `tools`.
 * Ninguna publica servicios, así que las filas no necesitan realm aislado.
 * @param ctx - el contexto Cordis de la fila.
 * @param config - la configuración validada por {@link Config}.
 */
export function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: 'wine_rss_latest',
    description:
      'Devuelve las últimas noticias del sector del vino publicadas en el feed RSS de Wine-Searcher, '
      + 'de la más reciente a la más antigua. Úsala como punto de partida cuando haya que comentar la '
      + 'actualidad del vino o recomendar a partir de una noticia. Copia el enlace tal cual: es la fuente.',
    parameters: {
      n: {
        type: 'integer',
        description: `Cuántas noticias devolver, de 1 a ${config.maxItems}. Por defecto 1 (la más reciente).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                titulo: { type: 'string', required: true },
                resumen: { type: 'string', required: true },
                enlace: { type: 'string', required: true },
                publicado: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.length === 0
          ? 'El feed no devolvió ninguna noticia.'
          : value.items
            .map((item, index) => [
              `${index + 1}. ${item.titulo}`,
              item.publicado && `   Publicado: ${item.publicado}`,
              item.enlace && `   Enlace: ${item.enlace}`,
              item.resumen && `   ${item.resumen}`,
            ].filter(Boolean).join('\n'))
            .join('\n\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = args.n ?? 1
      if (!Number.isInteger(requested) || requested < 1 || requested > config.maxItems) {
        throw new Error(`n debe ser un entero entre 1 y ${config.maxItems} (recibido ${args.n})`)
      }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      let response
      try {
        response = await fetch(config.feedUrl, {
          signal,
          headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
        })
      } catch (error) {
        if (exec.signal.aborted) throw error
        throw new Error(`no se pudo consultar el feed ${config.feedUrl}: ${error.message}`)
      }
      if (!response.ok) {
        throw new Error(`el feed ${config.feedUrl} respondió ${response.status} ${response.statusText}`)
      }
      return { items: parseFeed(await response.text(), requested) }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Noticias de Wine-Searcher (${args.n ?? 1})`,
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'wine_stock_list',
    description:
      'Devuelve el catálogo completo de vinos disponibles en la tienda, con su product_id, región, uva, '
      + 'tipo, precio y unidades en stock. Consúltalo antes de recomendar: solo son recomendables los '
      + 'product_id que aparezcan aquí.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: WINE_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.length === 0
          ? 'El catálogo está vacío.'
          : value.items
            .map((wine) => `- ${wine.product_id} | ${wine.nombre} (${wine.tipo ?? '?'}, ${wine.region ?? '?'},`
              + ` ${wine.uva ?? '?'}) | stock=${wine.stock ?? '?'} | ${wine.precio_eur ?? '?'}€`)
            .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return { items: await loadStock(config.stockPath, exec.signal) }
    },
    presentCall: () => ({ card: 'generic', title: 'Catálogo de la tienda', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'wine_recommend',
    description:
      'Registra la recomendación final: una noticia resumida y EXACTAMENTE un vino del catálogo que '
      + 'conecte con ella. Valida la propuesta y la rechaza si el product_id no existe en el stock, si '
      + 'falta el motivo o si el resumen es demasiado corto; en ese caso corrige y vuelve a llamarla. '
      + 'Llámala una sola vez, al final, cuando ya tengas la noticia y hayas visto el catálogo.',
    parameters: {
      titulo: { type: 'string', required: true, description: 'El titular de la noticia.' },
      resumen: {
        type: 'string',
        required: true,
        description: 'Resumen de la noticia en 2-3 frases en español, escrito por ti, no copiado del feed.',
      },
      enlace: { type: 'string', required: true, description: 'El enlace de la noticia, tal cual lo dio wine_rss_latest.' },
      product_id: {
        type: 'string',
        required: true,
        description: 'El product_id exacto del vino recomendado, tal como aparece en wine_stock_list.',
      },
      motivo: {
        type: 'string',
        required: true,
        description: 'Por qué ese vino conecta con la noticia: región, uva, tipo o contexto.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          product_id: { type: 'string', required: true },
          noticia: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              titulo: { type: 'string', required: true },
              resumen: { type: 'string', required: true },
              enlace: { type: 'string', required: true },
            },
          },
          recomendacion: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              product_id: { type: 'string', required: true },
              motivo: { type: 'string', required: true },
            },
          },
          vino: WINE_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recomendación registrada: ${value.product_id}`
          + `${value.vino ? ` (${value.vino.nombre})` : ''} para «${value.noticia.titulo}».`,
      }],
    },
    async execute(args, exec) {
      const titulo = args.titulo.trim()
      const resumen = args.resumen.trim()
      const enlace = args.enlace.trim()
      const motivo = args.motivo.trim()
      const productId = args.product_id.trim()

      const problemas = []
      if (!titulo) problemas.push('falta el título de la noticia')
      if (resumen.length < config.minResumenChars) {
        problemas.push(`el resumen es demasiado corto (${resumen.length} caracteres,`
          + ` mínimo ${config.minResumenChars})`)
      }
      if (!enlace) problemas.push('falta el enlace de la noticia')
      if (!motivo) problemas.push('falta el motivo de la recomendación')

      const stock = await loadStock(config.stockPath, exec.signal)
      const vino = stock.find((item) => item.product_id === productId)
      if (!vino) {
        problemas.push(`product_id "${productId}" no está en el stock; los válidos son: `
          + `${stock.map((item) => item.product_id).join(', ')}`)
      }
      if (problemas.length > 0) throw new Error(`recomendación inválida: ${problemas.join('; ')}`)

      return {
        product_id: productId,
        noticia: { titulo, resumen, enlace },
        recomendacion: { product_id: productId, motivo },
        vino,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Recomendar ${args.product_id}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
