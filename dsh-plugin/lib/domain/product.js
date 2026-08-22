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
const UNIDADES_ML = { ml: 1, cl: 10, l: 1000 }

/**
 * Convierte un número con formato local en número de JS: quita el símbolo de
 * moneda y los espacios, y resuelve los separadores que declara `source`.
 * @param raw - el valor tal cual viene del fichero.
 * @param source - el bloque `source` de la configuración.
 * @returns el número, o `null` si no hay ninguno reconocible.
 */
function parseNumero(raw, source = {}) {
  const decimal = source.decimalSeparator ?? ','
  const miles = source.thousandsSeparator ?? '.'
  let texto = String(raw ?? '').replace(/[\s ]/g, '')
  if (source.currencySymbol) texto = texto.split(source.currencySymbol).join('')
  if (!texto) return null

  const negativo = texto.startsWith('-')
  if (negativo) texto = texto.slice(1)

  if (texto.includes(decimal)) {
    texto = texto.split(miles).join('').split(decimal).join('.')
  } else if (texto.includes(miles)) {
    // Con un solo separador el valor es ambiguo: "1.500" son mil quinientos y
    // "3.9" son tres y nueve décimas. Se lee como separador de miles solo si
    // agrupa de tres en tres, que es lo que la configuración declara que hace.
    const agrupado = new RegExp(`^\\d{1,3}(?:\\${miles}\\d{3})+$`).test(texto)
    texto = agrupado ? texto.split(miles).join('') : texto.split(miles).join('.')
  }

  if (!/^\d+(?:\.\d+)?$/.test(texto)) return null
  const valor = Number(texto)
  if (!Number.isFinite(valor)) return null
  return negativo ? -valor : valor
}

/**
 * Convierte una fecha con el formato que declara `source.dateFormat` a ISO.
 * @param raw - el valor del fichero (`10/4/2026`).
 * @param formato - el patrón declarado (`d/M/yyyy`).
 * @returns la fecha como `aaaa-mm-dd`, o `null` si no es una fecha real.
 */
function parseFecha(raw, formato = 'd/M/yyyy') {
  const texto = String(raw ?? '').trim()
  if (!texto) return null

  const separador = (formato.match(/[^a-zA-Z]/) ?? ['/'])[0]
  const orden = formato.split(separador)
  const partes = texto.split(separador)
  if (partes.length !== orden.length) return null

  const campos = {}
  orden.forEach((token, indice) => { campos[token[0].toLowerCase()] = Number(partes[indice]) })
  const { y: anio, m: mes, d: dia } = campos
  if (![anio, mes, dia].every(Number.isInteger)) return null

  const fecha = new Date(Date.UTC(anio, mes - 1, dia))
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    return null
  }
  return fecha.toISOString().slice(0, 10)
}

/**
 * Lee el flag booleano del ERP con los valores que declara `normalize.blocked`.
 * @param raw - el valor del fichero.
 * @param cfg - las listas de valores verdaderos y falsos.
 * @returns el booleano, o `null` si el valor no está en ninguna lista.
 */
function parseBooleano(raw, cfg = {}) {
  const texto = String(raw ?? '').trim().toLowerCase()
  const contiene = (lista) => (lista ?? []).some((valor) => String(valor).trim().toLowerCase() === texto)
  if (contiene(cfg.trueValues)) return true
  if (contiene(cfg.falseValues ?? [''])) return false
  return null
}

/** Formatea un número para mostrarlo con coma decimal: `1.5` → `1,5`. */
function conComaDecimal(numero) {
  return String(numero).replace('.', ',')
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
function extraerFormato(titulo, normalize = {}) {
  const cfg = normalize.extractFormat
  if (!cfg || cfg.enabled === false) return { titulo, formato: null, volumenMl: null }

  for (const patron of cfg.patterns ?? []) {
    const encaje = titulo.match(new RegExp(patron, 'i'))
    if (!encaje) continue
    const numero = Number(String(encaje[1]).replace(',', '.'))
    const unidad = String(encaje[2]).toLowerCase()
    if (!Number.isFinite(numero) || !(unidad in UNIDADES_ML)) continue
    return {
      titulo: titulo.slice(0, encaje.index),
      // Se publica como opción de variante, así que va como lo escribiría la
      // tienda: `75 cl`, `1,5 L`.
      formato: `${conComaDecimal(numero)} ${unidad === 'l' ? 'L' : unidad}`,
      volumenMl: Math.round(numero * UNIDADES_ML[unidad]),
    }
  }
  return { titulo, formato: null, volumenMl: null }
}

/** Capitaliza un tramo de letras respetando acentos y eñes. */
function capitalizar(tramo) {
  return tramo.replace(
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
function titular(raw, normalize = {}) {
  const cfg = normalize.titleCase
  const activo = cfg === true || (!!cfg && typeof cfg === 'object' && cfg.enabled !== false)
  // El ERP deja puntos y espacios de relleno al final ("... 75 cl..").
  const limpio = String(raw ?? '').replace(/[\s ]+/g, ' ').replace(/[\s.]+$/, '').trim()
  if (!activo || !limpio) return limpio

  const opciones = typeof cfg === 'object' ? cfg : {}
  const llanas = new Set((opciones.lowercaseWords ?? []).map((palabra) => palabra.toLowerCase()))
  const siglas = new Map((opciones.keepUppercase ?? []).map((palabra) => [palabra.toLowerCase(), palabra]))

  // Los guiones se tratan como separadores de palabra para que las
  // denominaciones compuestas queden bien: JEREZ-XÉRÈS-SHERRY, CHÂTEAUNEUF-DU-PAPE.
  const tramo = (texto, primero) => {
    const clave = texto.toLowerCase()
    if (siglas.has(clave)) return siglas.get(clave)
    if (/\d/.test(texto)) return texto
    if (!primero && llanas.has(clave)) return clave
    return capitalizar(texto)
  }

  return limpio
    .split(' ')
    .map((palabra, indice) => palabra
      .split('-')
      .map((parte, sub) => tramo(parte, indice === 0 && sub === 0))
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
export function normalizeRow(row, config, numeroFila) {
  const valor = (clave) => {
    const columna = config.columns[clave]
    const bruto = columna === undefined ? undefined : row[columna]
    return bruto === undefined || bruto === null ? '' : String(bruto).trim()
  }

  const avisos = []
  const rechazos = []
  const avisar = (code, field, message) => avisos.push({ code, field, message })

  const sku = valor('sku')
  if (!sku && config.normalize?.skipRows?.emptySku !== false) rechazos.push('sku vacío')

  const titleRaw = valor('title')
  const { titulo: sinFormato, formato, volumenMl } = extraerFormato(titleRaw, config.normalize)
  if (!formato) {
    avisar('sinFormato', 'format', `no se reconoce el formato del envase en "${titleRaw}"`)
  }
  const title = titular(sinFormato, config.normalize)
  if (!title) rechazos.push('título vacío')

  const precioRaw = valor('price')
  const price = parseNumero(precioRaw, config.source)
  if (price === null) rechazos.push(`price: valor no numérico "${precioRaw || '(vacío)'}"`)

  const stockRaw = valor('stock')
  const stockNumero = parseNumero(stockRaw, config.source)
  const stock = Number.isInteger(stockNumero) ? stockNumero : null
  if (stock === null) rechazos.push(`stock: valor no entero "${stockRaw || '(vacío)'}"`)
  else if (stock < 0 && config.normalize?.skipRows?.negativeStock) rechazos.push(`stock negativo (${stock})`)

  const costeRaw = valor('cost')
  const cost = costeRaw ? parseNumero(costeRaw, config.source) : null
  if (costeRaw && cost === null) {
    avisar('costeInvalido', 'cost', `valor no numérico "${costeRaw}"`)
  }

  const group = valor('group')
  const mapeo = config.taxonomy.groups[group]
  if (!mapeo?.productType) {
    rechazos.push(`grupo "${group || '(vacío)'}" no declarado en taxonomy.groups`)
  }

  const origenRaw = valor('origin')
  // El ERP escribe un guión cuando el producto no tiene denominación.
  const origin = origenRaw && origenRaw !== '-' ? titular(origenRaw, config.normalize) : null
  if (!origin) avisar('sinOrigen', 'origin', 'el fichero no trae denominación de origen')

  const fechaRaw = valor('modifiedAt')
  const modifiedAt = fechaRaw ? parseFecha(fechaRaw, config.source.dateFormat) : null
  if (fechaRaw && modifiedAt === null) {
    avisar('fechaInvalida', 'modifiedAt', `no es una fecha ${config.source.dateFormat ?? 'd/M/yyyy'}: "${fechaRaw}"`)
  }

  const bloqueoRaw = valor('blocked')
  let blocked = parseBooleano(bloqueoRaw, config.normalize?.blocked)
  if (blocked === null) {
    // Conservador: un flag que no se entiende no puede acabar publicando como
    // activo un producto que el ERP tenía bloqueado.
    avisar('bloqueoDesconocido', 'blocked', `valor "${bloqueoRaw}" no está en normalize.blocked; se trata como bloqueado`)
    blocked = true
  }

  if (rechazos.length > 0) {
    return { rejected: { row: numeroFila, sku: sku || null, reason: rechazos.join('; ') } }
  }

  const productionType = valor('productionType') || null
  const tags = []
  if (origin && config.taxonomy?.origin?.asTag) tags.push(origin)
  if (productionType) {
    // Lo que la configuración no traduce se publica tal cual, como dice el contrato.
    tags.push(config.taxonomy?.productionTypes?.[productionType] ?? productionType)
  }
  for (const tag of mapeo.tags ?? []) tags.push(tag)

  const supplierCode = valor('supplierCode') || null

  return {
    product: {
      sku,
      titleRaw,
      title,
      format: formato,
      volumeMl: volumenMl,
      group,
      productType: mapeo.productType,
      category: valor('category') || null,
      origin,
      countryCode: valor('countryCode') || null,
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
      warnings: avisos,
      row: numeroFila,
    },
  }
}
