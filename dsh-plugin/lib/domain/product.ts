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

import type { CatalogConfig } from '../config.ts'

/** Lo que el fichero no dice de un producto. No impide publicarlo. */
export interface ProductWarning {
  readonly code: string
  readonly field: string
  readonly message: string
}

/**
 * Un producto de la tienda, ya normalizado.
 *
 * Modelo neutro a propósito: NO es la forma de Shopify. `status`, los metafields
 * y las variantes los compone la etapa 5 a partir de `blocked`, `origin` y
 * `format`, así que un cliente que publique en otra plataforma no obliga a tocar
 * la normalización.
 */
export interface Product {
  readonly sku: string
  readonly titleRaw: string
  readonly title: string
  readonly format: string | null
  readonly volumeMl: number | null
  readonly group: string
  readonly productType: string
  readonly category: string | null
  readonly origin: string | null
  readonly countryCode: string | null
  readonly productionType: string | null
  readonly tags: readonly string[]
  readonly price: number
  readonly cost: number | null
  readonly stock: number
  readonly blocked: boolean
  readonly supplierCode: string | null
  readonly vendor: string | null
  readonly modifiedAt: string | null
  readonly warnings: readonly ProductWarning[]
  readonly row: number
}

/** Una fila que no llega a producto, con el motivo y dónde estaba. */
export interface RejectedRow {
  readonly row: number
  readonly sku: string | null
  readonly reason: string
}

/** Una fila del fichero, ya parseada y con la cabecera recortada. */
export type SourceRow = Readonly<Record<string, string | undefined>>

type SourceCfg = Partial<CatalogConfig['source']>
type NormalizeCfg = NonNullable<CatalogConfig['normalize']>

/** Unidades de volumen del formato del envase, en mililitros. */
const ML_PER_UNIT: Record<string, number> = { ml: 1, cl: 10, l: 1000 }

/**
 * Convierte un número con formato local en número de JS: quita el símbolo de
 * moneda y los espacios, y resuelve los separadores que declara `source`.
 * @param raw - el valor tal cual viene del fichero.
 * @param source - el bloque `source` de la configuración.
 * @returns el número, o `null` si no hay ninguno reconocible.
 */
function parseNumber(raw: unknown, source: SourceCfg = {}): number | null {
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
function parseDate(raw: unknown, pattern = 'd/M/yyyy'): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null

  const separator = (pattern.match(/[^a-zA-Z]/) ?? ['/'])[0] ?? '/'
  const order = pattern.split(separator)
  const parts = text.split(separator)
  if (parts.length !== order.length) return null

  const fields: Record<string, number> = {}
  order.forEach((token, index) => {
    const initial = token[0]
    if (initial) fields[initial.toLowerCase()] = Number(parts[index])
  })
  const year = fields.y
  const month = fields.m
  const day = fields.d
  if (year === undefined || month === undefined || day === undefined) return null
  if (![year, month, day].every(Number.isInteger)) return null

  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
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
function parseBoolean(raw: unknown, cfg: NonNullable<NormalizeCfg['blocked']> = {}): boolean | null {
  const text = String(raw ?? '').trim().toLowerCase()
  const includes = (list?: readonly string[]) =>
    (list ?? []).some((value) => String(value).trim().toLowerCase() === text)
  if (includes(cfg.trueValues)) return true
  if (includes(cfg.falseValues ?? [''])) return false
  return null
}

/** Formatea un número para mostrarlo con coma decimal: `1.5` → `1,5`. */
function withDecimalComma(number: number): string {
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
function extractFormat(rawTitle: string, normalize: NormalizeCfg = {}): { title: string, format: string | null, volumeMl: number | null } {
  const cfg = normalize.extractFormat
  const sinFormato = { title: rawTitle, format: null, volumeMl: null }
  if (!cfg || cfg.enabled === false) return sinFormato

  for (const pattern of cfg.patterns ?? []) {
    const match = rawTitle.match(new RegExp(pattern, 'i'))
    if (!match) continue
    const number = Number(String(match[1]).replace(',', '.'))
    const unit = String(match[2]).toLowerCase()
    const perUnit = ML_PER_UNIT[unit]
    if (!Number.isFinite(number) || perUnit === undefined) continue
    return {
      title: rawTitle.slice(0, match.index),
      // Se publica como opción de variante, así que va como lo escribiría la
      // tienda: `75 cl`, `1,5 L`.
      format: `${withDecimalComma(number)} ${unit === 'l' ? 'L' : unit}`,
      volumeMl: Math.round(number * perUnit),
    }
  }
  return sinFormato
}

/** Capitaliza un tramo de letras respetando acentos y eñes. */
function capitalize(segment: string): string {
  return segment.replace(
    /[\p{L}\p{M}]+/gu,
    (letters) => (letters[0] ?? '').toLocaleUpperCase('es') + letters.slice(1).toLocaleLowerCase('es'),
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
function toTitleCase(raw: unknown, normalize: NormalizeCfg = {}): string {
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
  const segment = (text: string, firstResult: boolean): string => {
    const key = text.toLowerCase()
    if (keepUppercase.has(key)) return keepUppercase.get(key) ?? text
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
export function normalizeRow(row: SourceRow, config: CatalogConfig, rowNumber: number): { product: Product } | { rejected: RejectedRow } {
  const value = (key: string): string => {
    const column = config.columns[key]
    const raw = column === undefined ? undefined : row[column]
    return raw === undefined || raw === null ? '' : String(raw).trim()
  }

  const warnings: ProductWarning[] = []
  const rejections: string[] = []
  const warn = (code: string, field: string, message: string) => warnings.push({ code, field, message })

  const sku = value('sku')
  if (!sku && config.normalize?.skipRows?.emptySku !== false) rejections.push('sku vacío')

  const titleRaw = value('title')
  const { title: withoutFormat, format, volumeMl } = extractFormat(titleRaw, config.normalize)
  if (!format) {
    warn('sinFormato', 'format', `no se reconoce el formato del envase en "${titleRaw}"`)
  }
  const title = toTitleCase(withoutFormat, config.normalize)
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
    warn('costeInvalido', 'cost', `valor no numérico "${costeRaw}"`)
  }

  const group = value('group')
  const groupMapping = config.taxonomy.groups[group]
  if (!groupMapping?.productType) {
    rejections.push(`grupo "${group || '(vacío)'}" no declarado en taxonomy.groups`)
  }

  const origenRaw = value('origin')
  // El ERP escribe un guión cuando el producto no tiene denominación.
  const origin = origenRaw && origenRaw !== '-' ? toTitleCase(origenRaw, config.normalize) : null
  if (!origin) warn('sinOrigen', 'origin', 'el fichero no trae denominación de origen')

  const rawDate = value('modifiedAt')
  const modifiedAt = rawDate ? parseDate(rawDate, config.source.dateFormat) : null
  if (rawDate && modifiedAt === null) {
    warn('fechaInvalida', 'modifiedAt', `no es una fecha ${config.source.dateFormat ?? 'd/M/yyyy'}: "${rawDate}"`)
  }

  const bloqueoRaw = value('blocked')
  let blocked = parseBoolean(bloqueoRaw, config.normalize?.blocked)
  if (blocked === null) {
    // Conservador: un flag que no se entiende no puede acabar publicando como
    // activo un producto que el ERP tenía bloqueado.
    warn('bloqueoDesconocido', 'blocked', `valor "${bloqueoRaw}" no está en normalize.blocked; se trata como bloqueado`)
    blocked = true
  }

  // Llegados aquí, los rechazos de arriba garantizan que estos tres existen; el
  // compilador no puede saberlo, así que se afirma en un solo sitio.
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
  for (const tag of groupMapping?.tags ?? []) tags.push(tag)

  const supplierCode = value('supplierCode') || null

  return {
    product: {
      sku,
      titleRaw,
      title,
      format,
      volumeMl,
      group,
      productType: groupMapping?.productType ?? '',
      category: value('category') || null,
      origin,
      countryCode: value('countryCode') || null,
      productionType,
      tags: [...new Set(tags)],
      price: price as number,
      cost,
      stock: stock as number,
      blocked,
      supplierCode,
      // Un código interno de proveedor no es un nombre de marca: sin
      // correspondencia declarada, `vendor` se queda sin rellenar.
      vendor: (supplierCode && config.taxonomy?.suppliers?.[supplierCode]) || null,
      modifiedAt,
      warnings,
      row: rowNumber,
    },
  }
}
