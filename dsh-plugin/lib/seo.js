/**
 * Etapa 3: los textos SEO de cada ficha de producto.
 *
 * Módulo puro y sin dependencias: construye el prompt y **valida el borrador**.
 * No llama a ningún modelo — eso lo hace el tool de `index.js`, que es quien
 * tiene acceso al de la sesión. El reparto es deliberado: la parte que se puede
 * comprobar se comprueba con tests, y la que no, se acota con reglas duras.
 *
 * Las reglas salen de «SEO Product Descriptions: 7 Tips to Optimize Product
 * Pages» (shopify.com/enterprise/blog/seo-product-descriptions) y viven en el
 * bloque `description` de `catalog.config.yml`, no aquí.
 *
 * @module dsh-plugin-catalog-agent/seo
 */

/** Los campos que el modelo tiene que devolver, y que se publican en Shopify. */
export const SEO_FIELDS = [
  'seoTitle', 'seoDescription', 'bodyHtml', 'handle', 'altText', 'feedDescription',
]

/** Qué es cada campo en Shopify, para el prompt y para el README. */
export const FIELD_ROLES = {
  seoTitle: 'meta title de la página de producto',
  seoDescription: 'meta description que sale en el resultado de búsqueda',
  bodyHtml: 'la descripción de la ficha',
  handle: 'el trozo final de la URL del producto',
  altText: 'el texto alternativo de la foto',
  feedDescription: 'la descripción para el feed de Google Merchant Center',
}

/** Quita las etiquetas de un HTML y normaliza los espacios. */
export function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Convierte un texto en un `handle` de Shopify: minúsculas, sin acentos y con
 * guiones. Se usa para proponer uno y para validar el que devuelve el modelo.
 * @param texto - el texto de partida.
 * @param maxChars - longitud máxima; se corta por guión para no partir palabras.
 * @returns el slug.
 */
export function slugify(texto, maxChars = 70) {
  const slug = String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length <= maxChars) return slug
  const cortado = slug.slice(0, maxChars)
  const ultimo = cortado.lastIndexOf('-')
  return (ultimo > 0 ? cortado.slice(0, ultimo) : cortado).replace(/-+$/, '')
}

/**
 * Las keywords de un producto, sacadas de los campos que declara
 * `description.keywordsFrom`.
 *
 * El punto 3 del artículo pide investigación de keywords con volumen y
 * dificultad; no tenemos esa fuente, así que se derivan de lo que el fichero
 * dice del producto. Son ciertas, que es lo que importa para no inventar.
 * @param product - el producto normalizado.
 * @param config - la configuración cargada.
 * @returns las keywords, sin repetidas ni vacías.
 */
export function keywords(product, config) {
  const campos = config.description?.keywordsFrom ?? ['productType', 'origin']
  return [...new Set(campos.map((campo) => legible(product, campo, config)).filter(Boolean))]
}

/**
 * El valor de un campo tal como debe leerlo el modelo.
 *
 * El ERP manda códigos en mayúsculas (`ECOLOGICO`) y la taxonomía ya tiene su
 * forma legible: si al modelo le llega el código, lo escribe en la ficha.
 * @param product - el producto normalizado.
 * @param campo - el campo del modelo interno.
 * @param config - la configuración cargada.
 * @returns el valor legible, o `null` si el producto no lo trae.
 */
function legible(product, campo, config) {
  const bruto = product[campo]
  if (bruto === null || bruto === undefined || bruto === '') return null
  if (campo === 'productionType') return config.taxonomy?.productionTypes?.[bruto] ?? bruto
  return bruto
}

/** Los datos del producto que el modelo puede ver, y ninguno más. */
function datosVisibles(product, config) {
  const campos = config.description?.fields ?? ['title', 'productType']
  const datos = {}
  for (const campo of campos) {
    const valor = legible(product, campo, config)
    if (valor !== null) datos[campo] = valor
  }
  return datos
}

/**
 * Construye el prompt de un producto.
 *
 * Las cifras salen de la configuración, no del texto: cambiar un límite en
 * `catalog.config.yml` cambia lo que se le pide al modelo y lo que se le valida
 * después, que es la única forma de que no se contradigan.
 * @param product - el producto normalizado.
 * @param config - la configuración cargada.
 * @param problemas - lo que hay que corregir de un intento anterior.
 * @returns `{ system, user }`, los dos textos de la llamada.
 */
export function buildPrompt(product, config, problemas = []) {
  const d = config.description ?? {}
  const bullets = d.bodyHtml?.bullets ?? { min: 3, max: 5, maxChars: 90 }
  const claves = keywords(product, config)

  const system = [
    `Escribes fichas de producto para una tienda online, en ${d.language ?? 'es'}.`,
    d.tone ? `Tono: ${d.tone}` : '',
    d.audience ? `Le hablas a: ${d.audience}` : '',
    '',
    'Cómo se escribe una ficha que rinde en buscador:',
    '- Escribe para quien compra, no para el buscador. Di qué es el producto, para quién y cómo se usa.',
    '- Primero el beneficio y luego el dato que lo sostiene. El dato solo no vende: explica qué le hace al comprador.',
    '- La primera frase dice qué es el producto. Sin rodeos ni frases de apertura vacías.',
    '- Usa las keywords donde importan (título, primera frase, metadatos) y solo si describen el producto de verdad.',
    `- Nunca repitas la misma keyword más de ${d.maxKeywordRepeats ?? 3} veces: eso es keyword stuffing y penaliza.`,
    '- Cada ficha es distinta de las demás. Nada de plantillas ni de texto reciclado entre productos.',
    '- El texto alternativo describe lo que se ve en la foto, en lenguaje llano. No es un sitio para keywords.',
    '- La descripción del feed describe el mismo producto que la ficha, sin lenguaje promocional.',
    '',
    'Lo que NO puedes hacer:',
    ...(d.forbid ?? []).map((regla) => `- No menciones ${regla}.`),
    '- No inventes ningún dato que no esté en los datos del producto que te doy.',
    '- No uses lenguaje promocional (envío gratis, mejor precio, oferta limitada): eso va en otros campos de Shopify.',
    '',
    'Responde con seis bloques, cada uno abierto por su cabecera en una línea propia y nada más.',
    'Sin markdown alrededor, sin explicaciones, sin repetir estas instrucciones. Así exactamente:',
    '',
    `### seoTitle`,
    `${FIELD_ROLES.seoTitle}. Máximo ${d.seoTitle?.maxChars ?? 60} caracteres.`,
    '',
    `### seoDescription`,
    `${FIELD_ROLES.seoDescription}. Entre ${d.seoDescription?.minChars ?? 70} y ${d.seoDescription?.maxChars ?? 155} caracteres.`,
    '',
    `### bodyHtml`,
    `${FIELD_ROLES.bodyHtml}. Máximo ${d.bodyHtml?.maxChars ?? 700} caracteres.`
      + ` Exactamente un <p> de entrada de como mucho ${d.bodyHtml?.leadMaxWords ?? 40} palabras,`
      + ` y después un <ul> con entre ${bullets.min} y ${bullets.max} <li> de como mucho ${bullets.maxChars} caracteres cada uno.`
      + ` Solo estas etiquetas: ${(d.bodyHtml?.allowTags ?? ['p', 'ul', 'li']).join(', ')}.`
      + ' El HTML va tal cual, sin comillas alrededor y sin escapar nada.',
    '',
    `### handle`,
    `${FIELD_ROLES.handle}. Minúsculas, sin acentos, palabras separadas por guiones, máximo ${d.handle?.maxChars ?? 70} caracteres.`,
    '',
    `### altText`,
    `${FIELD_ROLES.altText}. Máximo ${d.altText?.maxChars ?? 125} caracteres.`,
    '',
    `### feedDescription`,
    `${FIELD_ROLES.feedDescription}. Máximo ${d.feedDescription?.maxChars ?? 500} caracteres.`,
    '',
    'Escribe los seis, en ese orden, y termina cada uno antes de abrir el siguiente.',
  ].filter(Boolean).join('\n')

  const partes = [
    'Datos del producto (es TODO lo que se sabe de él):',
    JSON.stringify(datosVisibles(product, config), null, 2),
  ]
  if (claves.length > 0) {
    partes.push(
      '',
      `Keywords que describen este producto: ${claves.join(', ')}.`,
      'Úsalas donde encajen de forma natural. Si alguna no encaja en una frase, no la metas.',
    )
  }
  if (problemas.length > 0) {
    partes.push(
      '',
      'Tu respuesta anterior no vale. Corrige exactamente esto y devuelve el JSON completo otra vez:',
      ...problemas.map((problema) => `- ${problema}`),
    )
  }

  return { system, user: partes.join('\n') }
}

/**
 * Saca los seis campos de la respuesta del modelo.
 *
 * El formato son bloques con cabecera en lugar de JSON porque el HTML dentro de
 * una cadena JSON era la parte frágil: había que escaparlo, y un corte a media
 * cadena tiraba la ficha entera. Con bloques, lo que llegó completo se conserva y
 * la validación pide solo lo que falta.
 *
 * Tolerante con lo que el modelo añade de su cosecha: se ignora cualquier
 * preámbulo antes del primer bloque, las cabeceras que no reconoce y el markdown
 * de cercado. Un campo que no aparece se queda vacío, y de eso ya avisa
 * {@link validateDraft}.
 * @param raw - el texto que devolvió el modelo.
 * @returns el borrador con los seis campos, ya recortados.
 */
export function parseBlocks(raw) {
  const texto = String(raw ?? '').replace(/^\s*```[a-z]*\s*$|^\s*```\s*$/gim, '')
  const borrador = {}
  for (const campo of SEO_FIELDS) borrador[campo] = ''

  // `### campo` en su propia línea abre un bloque; se cierra con el siguiente.
  const cabecera = new RegExp(`^[ \\t]*#{1,6}[ \\t]*(${SEO_FIELDS.join('|')})[ \\t]*:?[ \\t]*$`, 'gim')
  const marcas = [...texto.matchAll(cabecera)]
  if (marcas.length === 0) {
    throw new Error(
      'la respuesta no trae ningún bloque "### campo": '
      + `${texto.trim() ? `empieza por "${texto.trim().slice(0, 80)}…"` : 'está vacía'}`,
    )
  }

  // La cabecera se compara sin distinguir mayúsculas, así que hay que volver al
  // nombre canónico del campo: `#### Handle:` es `handle`.
  const canonico = new Map(SEO_FIELDS.map((campo) => [campo.toLowerCase(), campo]))
  marcas.forEach((marca, indice) => {
    const desde = marca.index + marca[0].length
    const hasta = indice + 1 < marcas.length ? marcas[indice + 1].index : texto.length
    borrador[canonico.get(marca[1].toLowerCase())] = texto.slice(desde, hasta).trim()
  })
  return borrador
}

/** Cuenta cuántas veces aparece `aguja` en `pajar`, sin distinguir mayúsculas. */
function veces(pajar, aguja) {
  if (!aguja) return 0
  const escapada = aguja.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (pajar.match(new RegExp(escapada, 'gi')) ?? []).length
}

/** Comprueba la estructura escaneable del cuerpo: un párrafo y luego bullets. */
function validarCuerpo(bodyHtml, config, anota) {
  const cfg = config.description?.bodyHtml ?? {}
  const bullets = cfg.bullets ?? { min: 3, max: 5, maxChars: 90 }
  const permitidas = cfg.allowTags ?? ['p', 'ul', 'li', 'strong', 'em']

  for (const etiqueta of bodyHtml.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)) {
    const nombre = etiqueta[1].toLowerCase()
    if (!permitidas.includes(nombre)) {
      anota('etiquetaProhibida', `bodyHtml usa la etiqueta <${nombre}>, que no está permitida (solo ${permitidas.join(', ')})`)
      break
    }
  }

  const entrada = bodyHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  if (!entrada) {
    anota('sinEntrada', 'bodyHtml no trae el <p> de entrada')
  } else {
    const palabras = stripTags(entrada[1]).split(/\s+/).filter(Boolean)
    const maximo = cfg.leadMaxWords ?? 40
    if (palabras.length > maximo) {
      anota('entradaLarga', `el <p> de entrada tiene ${palabras.length} palabras y el máximo es ${maximo}`)
    }
  }

  const lista = bodyHtml.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i)
  if (!lista) {
    anota('sinBullets', 'bodyHtml no trae el <ul> con los bullets, y la ficha tiene que poder escanearse en móvil')
    return
  }
  const puntos = [...lista[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1]))
  if (puntos.length < bullets.min || puntos.length > bullets.max) {
    anota('bulletsFuera', `hay ${puntos.length} bullets y tienen que ser entre ${bullets.min} y ${bullets.max}`)
  }
  for (const punto of puntos) {
    if (!punto) anota('bulletVacio', 'hay un bullet vacío')
    else if (punto.length > bullets.maxChars) {
      anota('bulletLargo', `un bullet tiene ${punto.length} caracteres y el máximo es ${bullets.maxChars}: "${punto.slice(0, 40)}…"`)
    }
  }
}

/**
 * Valida un borrador contra las reglas de la configuración.
 *
 * Devuelve los problemas en vez de lanzar, porque quien llama se los pasa al
 * modelo para que se corrija. Lista vacía es un borrador publicable.
 *
 * Cada problema lleva un `code` estable además del `message`: el mensaje es para
 * el modelo, y el código es para poder contar qué regla rechaza más borradores.
 * Sin ese recuento, decidir si una regla sobra o si hace falta otro modelo es
 * adivinar.
 * @param draft - el borrador ya parseado.
 * @param product - el producto al que corresponde.
 * @param config - la configuración cargada.
 * @param usados - `{ handles, textos }` de las demás fichas, para que no haya
 *   duplicados entre productos.
 * @returns los problemas encontrados, en español.
 */
export function validateDraft(draft, product, config, usados = {}) {
  const d = config.description ?? {}
  const problemas = []
  const handles = usados.handles ?? new Set()
  const textos = usados.textos ?? new Set()
  const anota = (code, message) => problemas.push({ code, message })

  for (const campo of SEO_FIELDS) {
    if (!draft[campo]) anota('faltaCampo', `falta ${campo}`)
  }
  if (problemas.length > 0) return problemas

  for (const campo of SEO_FIELDS) {
    const maximo = d[campo]?.maxChars
    if (maximo && draft[campo].length > maximo) {
      anota(`largo:${campo}`, `${campo} tiene ${draft[campo].length} caracteres y el máximo es ${maximo}`)
    }
    const minimo = d[campo]?.minChars
    if (minimo && draft[campo].length < minimo) {
      anota(`corto:${campo}`, `${campo} tiene ${draft[campo].length} caracteres y el mínimo es ${minimo}`)
    }
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.handle)) {
    anota('handleInvalido', `handle "${draft.handle}" no vale: solo minúsculas, números y guiones simples`)
  } else if (handles.has(draft.handle)) {
    anota('handleDuplicado', `handle "${draft.handle}" ya lo tiene otro producto, y la URL tiene que ser única`)
  }

  validarCuerpo(draft.bodyHtml, config, anota)

  // La primera frase tiene que decir qué es el producto. Vale el tipo, su palabra
  // principal o la categoría: hay grupos del ERP que se traducen a cubos
  // genéricos (`Otros`, `Estuche`) y exigir esa palabra fuerza una frase que
  // nadie escribiría —«es un otros»—, así que para esos el que tiene sentido es
  // el de la categoría («vino»).
  const entrada = draft.bodyHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  if (entrada && product.productType) {
    const texto = stripTags(entrada[1]).toLowerCase()
    const tipo = product.productType.toLowerCase()
    const acepta = [tipo, tipo.split(/\s+/)[0], product.category?.toLowerCase()].filter(Boolean)
    if (!acepta.some((palabra) => texto.includes(palabra))) {
      anota(
        'entradaSinTipo',
        'la primera frase no dice qué es el producto: tiene que nombrar '
        + acepta.map((palabra) => `"${palabra}"`).join(' o '),
      )
    }
  }

  // Nada de plantillas: dos productos no pueden compartir el mismo texto.
  for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
    if (textos.has(`${campo}:${draft[campo]}`)) {
      anota('textoDuplicado', `${campo} es idéntico al de otro producto; cada ficha tiene que ser distinta`)
    }
  }

  const todo = SEO_FIELDS.map((campo) => draft[campo]).join('\n')
  for (const frase of d.forbidPhrases ?? []) {
    if (todo.toLowerCase().includes(String(frase).toLowerCase())) {
      anota('promocional', `sobra el lenguaje promocional "${frase}": no va en la ficha ni en el feed`)
    }
  }

  // Lo que el fichero no dice, no se escribe. Si el dato SÍ está en el nombre
  // del producto, no es invención y se deja pasar.
  const propio = `${product.titleRaw ?? ''} ${product.title ?? ''}`.toLowerCase()
  for (const patron of d.forbidPatterns ?? []) {
    for (const encaje of todo.matchAll(new RegExp(patron, 'gi'))) {
      if (!propio.includes(encaje[0].toLowerCase())) {
        anota('inventado', `"${encaje[0]}" no está en los datos del producto: no te lo puedes inventar`)
        break
      }
    }
  }

  const cuerpo = stripTags(draft.bodyHtml)
  const maxRepeticiones = d.maxKeywordRepeats ?? 3
  for (const clave of keywords(product, config)) {
    const cuenta = veces(cuerpo, clave)
    if (cuenta > maxRepeticiones) {
      anota('stuffing', `"${clave}" aparece ${cuenta} veces en el cuerpo y el máximo son ${maxRepeticiones} (keyword stuffing)`)
    }
  }

  return problemas
}
