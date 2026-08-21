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
 * Las fuentes de noticias no están incrustadas aquí: se declaran en la fila del
 * preset, que es donde dsh quiere la configuración.
 *
 * @module dsh-plugin-catalog-agent
 */

export const name = 'catalog-agent'
export const inject = ['tools']

export const Config = z.object({
  stockPath: z.string().required(),
  feeds: z
    .array(
      z.object({
        id: z.string().required(),
        nombre: z.string(),
        url: z.string().required(),
      }),
    )
    .default([
      {
        id: 'wine-searcher',
        nombre: 'Wine-Searcher',
        url: 'https://www.wine-searcher.com/rss-feed/dept/all',
      },
    ]),
  timeoutMs: z.number().default(15000),
  maxItems: z.number().default(10),
  minResumenChars: z.number().default(20),
  articleMaxChars: z.number().default(6000),
})

const USER_AGENT = 'Mozilla/5.0 (compatible; dsh-plugin-wine-agent/0.1)'
const ACCEPT_FEED = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * Convierte marcado en texto plano legible: quita CDATA, etiquetas y entidades, y
 * colapsa los espacios. Lo usan tanto el lector de feeds como el de artículos.
 * @param raw - el contenido crudo.
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
 * Lee el primer nodo presente de entre varios nombres dentro de un bloque.
 * @param block - el XML de la entrada.
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
 * Saca el enlace de una entrada, cubriendo las dos convenciones: RSS lo pone como
 * contenido de `<link>` y Atom como atributo `href`.
 * @param block - el XML de la entrada.
 * @returns la URL, o cadena vacía.
 */
function readLink(block) {
  const atom = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i)
  if (atom) return toText(atom[1])
  return readTag(block, ['link', 'guid', 'id'])
}

/**
 * Extrae las noticias de un feed RSS 2.0 o Atom. Deliberadamente tolerante: un feed
 * sin entradas devuelve una lista vacía y quien llama decide qué hacer.
 * @param xml - el cuerpo del feed.
 * @returns las noticias ya normalizadas, en el orden en que venían.
 */
function parseFeed(xml) {
  const items = []
  for (const match of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const block = match[2]
    items.push({
      titulo: readTag(block, ['title']),
      resumen: readTag(block, ['description', 'summary', 'content:encoded', 'content']),
      enlace: readLink(block),
      publicado: readTag(block, ['pubDate', 'published', 'updated', 'dc:date']),
    })
  }
  return items
}

/**
 * Ordena de más reciente a más antigua. Una fecha ilegible se va al final en vez de
 * envenenar la comparación.
 * @param item - la noticia.
 * @returns el instante de publicación en milisegundos, o 0.
 */
function instante(item) {
  const ms = Date.parse(item.publicado)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * Descarga y parsea un feed. No lanza: el fallo de una fuente se devuelve como dato
 * para que una fuente caída no tumbe la llamada entera.
 * @param feed - la fuente configurada.
 * @param config - la configuración del plugin.
 * @param signal - la señal de cancelación de la ejecución.
 * @returns las noticias de esa fuente, o el error que impidió leerla.
 */
async function leerFeed(feed, config, signal) {
  try {
    const response = await fetch(feed.url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      headers: { 'user-agent': USER_AGENT, accept: ACCEPT_FEED },
    })
    if (!response.ok) {
      return { feed, items: [], error: `respondió ${response.status} ${response.statusText}` }
    }
    const items = parseFeed(await response.text()).map((item) => ({ ...item, fuente: feed.id }))
    return { feed, items, error: '' }
  } catch (error) {
    if (signal.aborted) throw error
    return { feed, items: [], error: error.message }
  }
}

/**
 * Saca el cuerpo del artículo de una página, probando de lo mejor a lo peor:
 * el `articleBody` de JSON-LD (schema.org, lo publican muchos medios) y, si no,
 * la `og:description`.
 * @param html - el HTML de la página.
 * @returns `{ titulo, cuerpo, origen }`, o `null` si no hay nada aprovechable.
 */
function extraerArticulo(html) {
  for (const bloque of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let datos
    try {
      datos = JSON.parse(bloque[1])
    } catch {
      continue
    }
    const raiz = Array.isArray(datos) ? datos : [datos]
    const nodos = raiz.flatMap((n) => (n && Array.isArray(n['@graph']) ? n['@graph'] : [n]))
    for (const nodo of nodos) {
      if (nodo && typeof nodo === 'object' && typeof nodo.articleBody === 'string' && nodo.articleBody.trim()) {
        return {
          titulo: toText(String(nodo.headline ?? nodo.name ?? '')),
          cuerpo: toText(nodo.articleBody),
          origen: 'articulo',
        }
      }
    }
  }

  const og = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
  if (og && og[1].trim()) {
    const titulo = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    return {
      titulo: toText(titulo ? titulo[1] : ''),
      cuerpo: toText(og[1]),
      origen: 'descripcion',
    }
  }
  return null
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
 * Registra las herramientas del agente de vinos en el registro `tools`.
 * Ninguna publica servicios, así que la fila va suelta y sin realm aislado.
 * @param ctx - el contexto Cordis de la fila.
 * @param config - la configuración validada por {@link Config}.
 */
export function apply(ctx, config) {
  const ids = config.feeds.map((f) => f.id)
  const catalogoFuentes = config.feeds.map((f) => `${f.id}${f.nombre ? ` (${f.nombre})` : ''}`).join(', ')

  ctx.tools.register(defineTool({
    name: 'wine_rss_latest',
    description:
      'Devuelve las últimas noticias del sector del vino, de la más reciente a la más antigua, leídas de '
      + `las fuentes configuradas en la tienda: ${catalogoFuentes}. Úsala como punto de partida cuando haya `
      + 'que comentar la actualidad del vino o recomendar a partir de una noticia. Copia el enlace tal cual: '
      + 'es la fuente, y lo necesita wine_article_fetch para leer el artículo entero.',
    parameters: {
      n: {
        type: 'integer',
        description: `Cuántas noticias devolver, de 1 a ${config.maxItems}. Por defecto 1 (la más reciente).`,
      },
      fuente: {
        type: 'string',
        description:
          `De qué fuente leer. Valores válidos: ${ids.join(', ')}. `
          + 'Omítelo para mezclar todas las fuentes ordenadas por fecha, que es lo normal; '
          + 'úsalo solo si el usuario pide una fuente concreta.',
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
                fuente: { type: 'string', required: true },
              },
            },
          },
          fuentesConsultadas: { type: 'array', required: true, items: { type: 'string' } },
          fuentesFallidas: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fuente: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const partes = []
        if (value.items.length === 0) {
          partes.push('Ninguna de las fuentes consultadas devolvió noticias.')
        } else {
          partes.push(
            value.items
              .map((item, index) => [
                `${index + 1}. ${item.titulo}  [${item.fuente}]`,
                item.publicado && `   Publicado: ${item.publicado}`,
                item.enlace && `   Enlace: ${item.enlace}`,
                item.resumen && `   ${item.resumen}`,
              ].filter(Boolean).join('\n'))
              .join('\n\n'),
          )
        }
        if (value.fuentesFallidas.length > 0) {
          partes.push(
            'Fuentes que no se pudieron leer: '
            + value.fuentesFallidas.map((f) => `${f.fuente} (${f.error})`).join('; '),
          )
        }
        return [{ type: 'text', text: partes.join('\n\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = args.n ?? 1
      if (!Number.isInteger(requested) || requested < 1 || requested > config.maxItems) {
        throw new Error(`n debe ser un entero entre 1 y ${config.maxItems} (recibido ${args.n})`)
      }

      let seleccionadas = config.feeds
      if (args.fuente) {
        const buscada = args.fuente.trim().toLowerCase()
        seleccionadas = config.feeds.filter((f) => f.id.toLowerCase() === buscada)
        if (seleccionadas.length === 0) {
          throw new Error(`fuente "${args.fuente}" no configurada; las válidas son: ${ids.join(', ')}`)
        }
      }

      const resultados = await Promise.all(seleccionadas.map((feed) => leerFeed(feed, config, exec.signal)))
      const fallidas = resultados
        .filter((r) => r.error)
        .map((r) => ({ fuente: r.feed.id, error: r.error }))
      if (fallidas.length === resultados.length) {
        throw new Error(
          'no se pudo leer ninguna fuente: '
          + fallidas.map((f) => `${f.fuente} (${f.error})`).join('; '),
        )
      }

      const items = resultados
        .flatMap((r) => r.items)
        .sort((a, b) => instante(b) - instante(a))
        .slice(0, requested)

      return {
        items,
        fuentesConsultadas: seleccionadas.map((f) => f.id),
        fuentesFallidas: fallidas,
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Noticias de vino (${args.n ?? 1}${args.fuente ? `, ${args.fuente}` : ''})`,
      kind: 'other',
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'wine_article_fetch',
    description:
      'Descarga el artículo completo de una noticia a partir de su enlace y lo devuelve como texto. '
      + 'Llámala después de wine_rss_latest y ANTES de resumir: el feed solo trae un titular y una frase, '
      + 'y resumir a partir de eso obliga a inventar. Mira el campo `fuente` de la respuesta para saber '
      + 'con cuánto material estás trabajando de verdad.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'El enlace de la noticia, tal cual lo dio wine_rss_latest.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          titulo: { type: 'string', required: true },
          cuerpo: { type: 'string', required: true },
          caracteres: { type: 'integer', required: true },
          truncado: { type: 'boolean', required: true },
          fuente: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        if (value.fuente === 'feed') {
          return [{
            type: 'text',
            text: 'No se pudo extraer el artículo de esa página. Quédate con el titular y el resumen del '
              + 'feed, dilo explícitamente y no afirmes nada que no esté ahí.',
          }]
        }
        const cabecera = value.fuente === 'articulo'
          ? `Artículo completo (${value.caracteres} caracteres${value.truncado ? ', recortado' : ''}):`
          : `Solo se pudo recuperar la descripción de la página (${value.caracteres} caracteres). `
            + 'No hay cuerpo del artículo: no afirmes nada que no esté aquí.'
        return [{ type: 'text', text: `${value.titulo}\n\n${cabecera}\n\n${value.cuerpo}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const url = args.url.trim()
      if (!/^https?:\/\//i.test(url)) throw new Error(`url debe ser http(s) (recibido "${args.url}")`)

      const vacio = { titulo: '', cuerpo: '', caracteres: 0, truncado: false, fuente: 'feed' }
      let response
      try {
        response = await fetch(url, {
          signal: AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)]),
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        })
      } catch (error) {
        if (exec.signal.aborted) throw error
        return vacio
      }
      if (!response.ok) return vacio

      const extraido = extraerArticulo(await response.text())
      if (!extraido) return vacio

      const truncado = extraido.cuerpo.length > config.articleMaxChars
      return {
        titulo: extraido.titulo,
        cuerpo: truncado ? extraido.cuerpo.slice(0, config.articleMaxChars) : extraido.cuerpo,
        caracteres: truncado ? config.articleMaxChars : extraido.cuerpo.length,
        truncado,
        fuente: extraido.origen,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Leer el artículo', kind: 'other', rawInput: args }),
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
        description:
          'Resumen de la noticia en 2-3 frases en español, escrito por ti a partir del cuerpo que '
          + 'devolvió wine_article_fetch. No afirmes nada que no esté en el material que tienes.',
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
