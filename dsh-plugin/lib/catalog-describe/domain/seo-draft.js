/**
 * El dominio de la etapa 3: qué es una ficha SEO válida.
 *
 * No se fuerza a dominio compartido porque solo lo usa esta tool. Aquí están las
 * reglas de negocio —longitudes, estructura escaneable, keyword stuffing, datos
 * que no se pueden inventar, unicidad entre fichas— y cada una lleva un `code`
 * estable para poder contar cuál rechaza más borradores.
 *
 * Las reglas salen de «SEO Product Descriptions: 7 Tips to Optimize Product
 * Pages» (shopify.com/enterprise/blog/seo-product-descriptions) y sus números
 * viven en el bloque `description` de `catalog.config.yml`, no aquí.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/domain/seo-draft
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
export
function legible(product, campo, config) {
  const bruto = product[campo]
  if (bruto === null || bruto === undefined || bruto === '') return null
  if (campo === 'productionType') return config.taxonomy?.productionTypes?.[bruto] ?? bruto
  return bruto
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
