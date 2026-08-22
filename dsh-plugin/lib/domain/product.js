/**
 * El dominio de Producto: qué es un producto de la tienda y cómo se construye a
 * partir de una fila del fichero del ERP.
 *
 * Es el ÚNICO dominio compartido entre tools: lo produce `catalog-load` y lo
 * consume `catalog-describe`. Puro y determinista: no lee ficheros, no llama a
 * nadie y no sabe de dónde viene la fila que le dan.
 *
 * Aquí viven los invariantes: qué hace impublicable a un producto (sin SKU, sin
 * precio, sin stock, sin grupo con el que categorizar) y qué solo lo deja
 * incompleto. Los formatos locales del ERP —coma decimal, el `€`, las fechas
 * `d/m/aaaa`, el envase pegado al nombre— se resuelven aquí y no salen de aquí.
 *
 * @module dsh-plugin-catalog-agent/domain/product
 */

/** Unidades de volumen del formato del envase, en mililitros. */
const ML_PER_UNIT = { ml: 1, cl: 10, l: 1000 }

/**
 * Convierte un número con formato local en número de JS: quita el símbolo de
 * moneda y los espacios, y resuelve los separadores que declara `source`.
 * @param raw - el valor tal cual viene del fichero.
 * @param source - el bloque `source` de la configuración.
 * @returns el número, o `null` si no hay ninguno reconocible.
 */
function parseNumber(raw, source = {}) {
  const decimal = source.decimalSeparator ?? ','
  const miles = source.thousandsSeparator ?? '.'
  let text = String(raw ?? '').replace(/[\s ]/g, '')
  if (source.currencySymbol) text = text.split(source.currencySymbol).join('')
  if (!text) return null

  const negativo = text.startsWith('-')
  if (negativo) text = text.slice(1)

  if (text.includes(decimal)) {
    text = text.split(miles).join('').split(decimal).join('.')
  } else if (text.includes(miles)) {
    // Con un solo separador el valor es ambiguo: "1.500" son mil quinientos y
    // "3.9" son tres y nueve décimas. Se lee como separador de miles solo si
    // agrupa de tres en tres, que es lo que la configuración declara que hace.
    const agrupado = new RegExp(`^\\d{1,3}(?:\\${miles}\\d{3})+$`).test(text)
    text = agrupado ? text.split(miles).join('') : text.split(miles).join('.')
  }

  if (!/^\d+(?:\.\d+)?$/.test(text)) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return negativo ? -value : value
}

/**
 * Convierte una fecha con el formato que declara `source.dateFormat` a ISO.
 * @param raw - el valor del fichero (`10/4/2026`).
 * @param formato - el patrón declarado (`d/M/yyyy`).
 * @returns la fecha como `aaaa-mm-dd`, o `null` si no es una fecha real.
 */
function parseDate(raw, formato = 'd/M/yyyy') {
  const text = String(raw ?? '').trim()
  if (!text) return null

  const separador = (formato.match(/[^a-zA-Z]/) ?? ['/'])[0]
  const orden = formato.split(separador)
  const partes = text.split(separador)
  if (partes.length !== orden.length) return null

  const campos = {}
  orden.forEach((token, index) => { campos[token[0].toLowerCase()] = Number(partes[index]) })
  const { y: anio, m: mes, d: dia } = campos
  if (![anio, mes, dia].every(Number.isInteger)) return null

  const date = new Date(Date.UTC(anio, mes - 1, dia))
  if (date.getUTCFullYear() !== anio || date.getUTCMonth() !== mes - 1 || date.getUTCDate() !== dia) {
    return null
  }
  return date.toISOString().slice(0, 10)
}

/**
 * Lee el flag booleano del ERP con los valores que declara `normalize.blocked`.
 * @param raw - el valor del fichero.
 * @param cfg - las listas de valores verdaderos y falsos.
 * @returns el booleano, o `null` si el valor no está en ninguna lista.
 */
function parseBoolean(raw, cfg = {}) {
  const text = String(raw ?? '').trim().toLowerCase()
  const contiene = (list) => (list ?? []).some((value) => String(value).trim().toLowerCase() === text)
  if (contiene(cfg.trueValues)) return true
  if (contiene(cfg.falseValues ?? [''])) return false
  return null
}

/** Formatea un número para mostrarlo con coma decimal: `1.5` → `1,5`. */
function withDecimalComma(number) {
  return String(number).replace('.', ',')
}

/**
 * Separa el formato del envase del final del título, que es donde el ERP lo pega.
 *
 * Tolerante a propósito: el mismo fichero escribe `75 cl.`, `75 CL.`, `75cl.`,
 * `1,5 L.` y `75 cl..`. Lo que no reconoce lo deja como aviso en vez de inventarlo.
 * @param titulo - el título crudo del ERP.
 * @param normalize - el bloque `normalize` de la configuración.
 * @returns el título sin el formato, el formato canónico y su volumen en mililitros.
 */
function extractFormat(titulo, normalize = {}) {
  const cfg = normalize.extractFormat
  if (!cfg || cfg.enabled === false) return { titulo, formato: null, volumenMl: null }

  for (const pattern of cfg.patterns ?? []) {
    const match = titulo.match(new RegExp(pattern, 'i'))
    if (!match) continue
    const number = Number(String(match[1]).replace(',', '.'))
    const unidad = String(match[2]).toLowerCase()
    if (!Number.isFinite(number) || !(unidad in ML_PER_UNIT)) continue
    return {
      titulo: titulo.slice(0, match.index),
      // Se publica como opción de variante, así que va como lo escribiría la
      // tienda: `75 cl`, `1,5 L`.
      formato: `${withDecimalComma(number)} ${unidad === 'l' ? 'L' : unidad}`,
      volumenMl: Math.round(number * ML_PER_UNIT[unidad]),
    }
  }
  return { titulo, formato: null, volumenMl: null }
}

/** Capitaliza un tramo de letras respetando acentos y eñes. */
function capitalize(segment) {
  return segment.replace(
    /[\p{L}\p{M}]+/gu,
    (letras) => letras[0].toLocaleUpperCase('es') + letras.slice(1).toLocaleLowerCase('es'),
  )
}

/**
 * Pasa un texto en MAYÚSCULAS del ERP a capitalización de escaparate.
 *
 * Las dos excepciones son configuración y no código, porque dependen del idioma
 * del cliente: `lowercaseWords` (las palabras llanas) y `keepUppercase` (siglas).
 * @param raw - el texto del ERP.
 * @param normalize - el bloque `normalize` de la configuración.
 * @returns el texto capitalizado, con los espacios colapsados.
 */
function toTitleCase(raw, normalize = {}) {
  const cfg = normalize.titleCase
  const activo = cfg === true || (!!cfg && typeof cfg === 'object' && cfg.enabled !== false)
  // El ERP deja puntos y espacios de relleno al final ("... 75 cl..").
  const limpio = String(raw ?? '').replace(/[\s ]+/g, ' ').replace(/[\s.]+$/, '').trim()
  if (!activo || !limpio) return limpio

  const opciones = typeof cfg === 'object' ? cfg : {}
  const lowercaseWords = new Set((opciones.lowercaseWords ?? []).map((word) => word.toLowerCase()))
  const keepUppercase = new Map((opciones.keepUppercase ?? []).map((word) => [word.toLowerCase(), word]))

  // Los guiones se tratan como separadores de palabra para que las
  // denominaciones compuestas queden bien: JEREZ-XÉRÈS-SHERRY, CHÂTEAUNEUF-DU-PAPE.
  const segment = (text, firstResult) => {
    const key = text.toLowerCase()
    if (keepUppercase.has(key)) return keepUppercase.get(key)
    if (/\d/.test(text)) return text
    if (!firstResult && lowercaseWords.has(key)) return key
    return capitalize(text)
  }

  return limpio
    .split(' ')
    .map((word, index) => word
      .split('-')
      .map((parte, part) => segment(parte, index === 0 && part === 0))
      .join('-'))
    .join(' ')
}

/**
 * Convierte una fila del fichero en un producto del modelo interno.
 *
 * El reparto entre rechazo y aviso es deliberado: se rechaza lo que hace el
 * producto impublicable (sin SKU, sin precio, sin stock, sin grupo con el que
 * categorizar) y se avisa de lo que solo lo deja incompleto.
 * @param row - la fila, ya con la cabecera recortada.
 * @param config - la configuración cargada.
 * @param numeroFila - la línea del fichero, para poder ir a mirarla.
 * @returns `{ product }` si es publicable, `{ rejected }` si no.
 */
export function normalizeRow(row, config, rowNumber) {
  const value = (key) => {
    const columna = config.columns[key]
    const bruto = columna === undefined ? undefined : row[columna]
    return bruto === undefined || bruto === null ? '' : String(bruto).trim()
  }

  const warnings = []
  const rejections = []
  const avisar = (code, field, message) => warnings.push({ code, field, message })

  const sku = value('sku')
  if (!sku && config.normalize?.skipRows?.emptySku !== false) rejections.push('sku vacío')

  const titleRaw = value('title')
  const { titulo: sinFormato, formato, volumenMl } = extractFormat(titleRaw, config.normalize)
  if (!formato) {
    avisar('sinFormato', 'format', `no se reconoce el formato del envase en "${titleRaw}"`)
  }
  const title = toTitleCase(sinFormato, config.normalize)
  if (!title) rejections.push('título vacío')

  const precioRaw = value('price')
  const price = parseNumber(precioRaw, config.source)
  if (price === null) rejections.push(`price: valor no numérico "${precioRaw || '(vacío)'}"`)

  const stockRaw = value('stock')
  const stockNumero = parseNumber(stockRaw, config.source)
  const stock = Number.isInteger(stockNumero) ? stockNumero : null
  if (stock === null) rejections.push(`stock: valor no entero "${stockRaw || '(vacío)'}"`)
  else if (stock < 0 && config.normalize?.skipRows?.negativeStock) rejections.push(`stock negativo (${stock})`)

  const costeRaw = value('cost')
  const cost = costeRaw ? parseNumber(costeRaw, config.source) : null
  if (costeRaw && cost === null) {
    avisar('costeInvalido', 'cost', `valor no numérico "${costeRaw}"`)
  }

  const group = value('group')
  const mapeo = config.taxonomy.groups[group]
  if (!mapeo?.productType) {
    rejections.push(`grupo "${group || '(vacío)'}" no declarado en taxonomy.groups`)
  }

  const origenRaw = value('origin')
  // El ERP escribe un guión cuando el producto no tiene denominación.
  const origin = origenRaw && origenRaw !== '-' ? toTitleCase(origenRaw, config.normalize) : null
  if (!origin) avisar('sinOrigen', 'origin', 'el fichero no trae denominación de origen')

  const rawDate = value('modifiedAt')
  const modifiedAt = rawDate ? parseDate(rawDate, config.source.dateFormat) : null
  if (rawDate && modifiedAt === null) {
    avisar('fechaInvalida', 'modifiedAt', `no es una fecha ${config.source.dateFormat ?? 'd/M/yyyy'}: "${rawDate}"`)
  }

  const bloqueoRaw = value('blocked')
  let blocked = parseBoolean(bloqueoRaw, config.normalize?.blocked)
  if (blocked === null) {
    // Conservador: un flag que no se entiende no puede acabar publicando como
    // activo un producto que el ERP tenía bloqueado.
    avisar('bloqueoDesconocido', 'blocked', `valor "${bloqueoRaw}" no está en normalize.blocked; se trata como bloqueado`)
    blocked = true
  }

  if (rejections.length > 0) {
    return { rejected: { row: rowNumber, sku: sku || null, reason: rejections.join('; ') } }
  }

  const productionType = value('productionType') || null
  const tags = []
  if (origin && config.taxonomy?.origin?.asTag) tags.push(origin)
  if (productionType) {
    // Lo que la configuración no traduce se publica tal cual, como dice el contrato.
    tags.push(config.taxonomy?.productionTypes?.[productionType] ?? productionType)
  }
  for (const tag of mapeo.tags ?? []) tags.push(tag)

  const supplierCode = value('supplierCode') || null

  return {
    product: {
      sku,
      titleRaw,
      title,
      format: formato,
      volumeMl: volumenMl,
      group,
      productType: mapeo.productType,
      category: value('category') || null,
      origin,
      countryCode: value('countryCode') || null,
      productionType,
      tags: [...new Set(tags)],
      price,
      cost,
      stock,
      blocked,
      supplierCode,
      // Un código interno de proveedor no es un nombre de marca: sin
      // correspondencia declarada, `vendor` se queda sin rellenar.
      vendor: (supplierCode && config.taxonomy?.suppliers?.[supplierCode]) || null,
      modifiedAt,
      warnings: warnings,
      row: rowNumber,
    },
  }
}
