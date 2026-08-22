/**
 * Adaptador de entrada de la carga: de dónde salen las filas.
 *
 * Lee el CSV del ERP y resuelve qué fichero hay que leer, incluidas las bandejas
 * de entrada. Es el único sitio que sabe que la fuente es un CSV y que conoce los
 * nombres de las columnas del cliente: el dominio recibe filas ya parseadas.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/infra/csv-source
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { parse } from 'csv-parse/sync'
import { REQUIRED_COLUMNS, resolveFromConfig } from '../../config.js'

/** Campos del modelo que se rellenan si la configuración los declara. */
const OPTIONAL_COLUMNS = [
  'cost', 'origin', 'countryCode', 'productionType', 'blocked',
  'supplierCode', 'category', 'modifiedAt',
]

/**
 * Las bandejas de entrada declaradas, ya resueltas.
 *
 * Acepta `dirs` (lista) y el `dir` de una sola carpeta que se usaba antes.
 * @param config - la configuración cargada.
 * @returns las rutas absolutas de las carpetas donde buscar.
 */
export function sourceDirs(config) {
  const declaradas = config.source?.dirs ?? (config.source?.dir ? [config.source.dir] : [])
  return declaradas.filter(Boolean).map((dir) => resolveFromConfig(config, dir))
}

/**
 * Resuelve qué fichero hay que leer a partir de lo que diga quien llama.
 *
 * dsh no admite adjuntar un CSV al chat, así que señalar la entrada es señalar un
 * fichero del disco. El orden va de lo más explícito a lo más cómodo: una ruta
 * absoluta se usa tal cual; una relativa con separadores cuelga del directorio de
 * trabajo del proceso; y un nombre suelto se busca en las bandejas de
 * `source.dirs`, en orden, donde con `pattern` basta el nombre sin extensión.
 * @param config - la configuración cargada.
 * @param entrada - lo que pidió quien llama, o nada para el fichero habitual.
 * @returns la ruta absoluta del fichero a leer.
 */
export function resolveSourcePath(config, entrada) {
  const pedido = entrada === undefined || entrada === null ? '' : String(entrada).trim()
  if (!pedido) return resolveFromConfig(config, config.source.path)
  if (isAbsolute(pedido)) return pedido
  if (pedido.includes(sep) || pedido.includes('/')) return resolve(pedido)

  const extension = extname(config.source.pattern ?? '') || '.csv'
  for (const bandeja of sourceDirs(config)) {
    for (const candidato of [pedido, `${pedido}${extension}`]) {
      const ruta = join(bandeja, candidato)
      if (existsSync(ruta)) return ruta
    }
  }
  return resolve(pedido)
}

/**
 * Dónde se ha buscado un fichero que no se encontró, para poder decirlo.
 * @param config - la configuración cargada.
 * @returns las rutas consultadas, en orden.
 */
export function searchedIn(config) {
  return [...sourceDirs(config), resolve('.')]
}

/**
 * Las columnas obligatorias que una cabecera no trae.
 * @param cabecera - los nombres de columna del fichero.
 * @param config - la configuración cargada.
 * @returns los nombres declarados que faltan.
 */
export
function columnasQueFaltan(cabecera, config) {
  return REQUIRED_COLUMNS
    .map((clave) => config.columns[clave])
    .filter((columna) => !cabecera.includes(columna))
}

/**
 * Lista los ficheros de la bandeja de entrada, diciendo de cada uno si sirve.
 *
 * Es lo que convierte «cuál es la entrada» en una conversación: en vez de teclear
 * una ruta a ciegas, se ve qué hay, cuántas filas tiene y si su cabecera encaja
 * con el mapeo de columnas.
 * @param config - la configuración cargada.
 * @returns `{ dir, existe, files }`; cada fichero con sus filas y su compatibilidad.
 */
export function listSources(config) {
  const extension = extname(config.source.pattern ?? '') || '.csv'
  const dirs = []
  const files = []

  for (const dir of sourceDirs(config)) {
    const existe = existsSync(dir)
    dirs.push({ dir, existe })
    if (!existe) continue

    for (const nombre of readdirSync(dir).sort()) {
      if (nombre.startsWith('.')) continue
      const ruta = join(dir, nombre)
      let info
      try {
        info = statSync(ruta)
      } catch {
        continue
      }
      if (!info.isFile()) continue

      const fichero = {
        name: nombre,
        dir,
        path: ruta,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString().slice(0, 10),
        rows: null,
        compatible: false,
        problema: null,
      }
      if (extname(nombre).toLowerCase() !== extension.toLowerCase()) {
        fichero.problema = `no es un ${extension} (la configuración solo lee ${config.source.format})`
      } else {
        try {
          const { rows } = readRows(config, ruta)
          const faltan = columnasQueFaltan(Object.keys(rows[0]), config)
          fichero.rows = rows.length
          fichero.compatible = faltan.length === 0
          if (faltan.length > 0) fichero.problema = `le faltan columnas: ${faltan.join(', ')}`
        } catch (error) {
          fichero.problema = error.message
        }
      }
      files.push(fichero)
    }
  }
  return { dirs, files }
}

/**
 * Lee el CSV y comprueba que trae las columnas declaradas.
 * @param config - la configuración cargada.
 * @param pathOverride - ruta alternativa, para probar contra el fixture.
 * @returns la ruta leída, las filas como objetos y las columnas opcionales que el
 *   fichero no trae.
 */
export function readRows(config, pathOverride) {
  const path = resolveSourcePath(config, pathOverride)
  let texto
  try {
    texto = readFileSync(path, { encoding: config.source.encoding ?? 'utf8' })
  } catch (error) {
    if (error.code === 'ENOENT' && pathOverride) {
      throw new Error(
        `no encuentro "${pathOverride}". He buscado en: ${searchedIn(config).join(', ')}. `
        + 'Usa catalog_sources para ver qué hay, o pasa la ruta absoluta.',
      )
    }
    throw new Error(`no se pudo leer el catálogo en ${path}: ${error.message}`)
  }

  const rows = parse(texto, {
    bom: true,
    delimiter: config.source.delimiter ?? ',',
    // El export del ERP viene en CRLF, pero un fichero editado a mano puede traer
    // los dos finales mezclados: se aceptan ambos en vez de fijar uno con la
    // primera línea y reventar en la segunda.
    record_delimiter: ['\r\n', '\n'],
    skip_empty_lines: true,
    relax_column_count: true,
    // La cabecera del ERP trae espacios de relleno (' Precio Venta tienda').
    columns: (header) => (config.source.trimHeaders === false
      ? header
      : header.map((nombre) => String(nombre).trim())),
  })
  if (rows.length === 0) throw new Error(`el catálogo en ${path} no trae ninguna fila`)

  const cabecera = Object.keys(rows[0])
  const faltan = columnasQueFaltan(cabecera, config)
  if (faltan.length > 0) {
    throw new Error(
      `el fichero ${path} no trae las columnas que declara la configuración: ${faltan.join(', ')}. `
      + `Las que trae son: ${cabecera.join(', ')}`,
    )
  }
  const columnasAusentes = OPTIONAL_COLUMNS
    .filter((clave) => config.columns[clave] && !cabecera.includes(config.columns[clave]))
    .map((clave) => `${clave} (${config.columns[clave]})`)

  return { path, rows, columnasAusentes }
}
