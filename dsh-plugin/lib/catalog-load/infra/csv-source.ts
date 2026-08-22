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
import { REQUIRED_COLUMNS, resolveFromConfig } from '../../config.ts'

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
export function resolveSourcePath(config, lead) {
  const requested = lead === undefined || lead === null ? '' : String(lead).trim()
  if (!requested) return resolveFromConfig(config, config.source.path)
  if (isAbsolute(requested)) return requested
  if (requested.includes(sep) || requested.includes('/')) return resolve(requested)

  const extension = extname(config.source.pattern ?? '') || '.csv'
  for (const inbox of sourceDirs(config)) {
    for (const candidato of [requested, `${requested}${extension}`]) {
      const path = join(inbox, candidato)
      if (existsSync(path)) return path
    }
  }
  return resolve(requested)
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
export function missingColumns(header, config) {
  return REQUIRED_COLUMNS
    .map((key) => config.columns[key])
    .filter((columna) => !header.includes(columna))
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
    const exists = existsSync(dir)
    dirs.push({ dir, exists })
    if (!exists) continue

    for (const entryName of readdirSync(dir).sort()) {
      if (entryName.startsWith('.')) continue
      const path = join(dir, entryName)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (!info.isFile()) continue

      const entry = {
        name: entryName,
        dir,
        path: path,
        bytes: info.size,
        modifiedAt: info.mtime.toISOString().slice(0, 10),
        rows: null,
        compatible: false,
        issue: null,
      }
      if (extname(entryName).toLowerCase() !== extension.toLowerCase()) {
        entry.issue = `no es un ${extension} (la configuración solo lee ${config.source.format})`
      } else {
        try {
          const { rows } = readRows(config, path)
          const missing = missingColumns(Object.keys(rows[0]), config)
          entry.rows = rows.length
          entry.compatible = missing.length === 0
          if (missing.length > 0) entry.issue = `le faltan columnas: ${missing.join(', ')}`
        } catch (error) {
          entry.issue = error.message
        }
      }
      files.push(entry)
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
  let text
  try {
    text = readFileSync(path, { encoding: config.source.encoding ?? 'utf8' })
  } catch (error) {
    if (error.code === 'ENOENT' && pathOverride) {
      throw new Error(
        `no encuentro "${pathOverride}". He buscado en: ${searchedIn(config).join(', ')}. `
        + 'Usa catalog_sources para ver qué hay, o pasa la ruta absoluta.',
      )
    }
    throw new Error(`no se pudo leer el catálogo en ${path}: ${error.message}`)
  }

  const rows = parse(text, {
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
      : header.map((entryName) => String(entryName).trim())),
  })
  if (rows.length === 0) throw new Error(`el catálogo en ${path} no trae ninguna fila`)

  const header = Object.keys(rows[0])
  const missing = missingColumns(header, config)
  if (missing.length > 0) {
    throw new Error(
      `el fichero ${path} no trae las columnas que declara la configuración: ${missing.join(', ')}. `
      + `Las que trae son: ${header.join(', ')}`,
    )
  }
  const absentColumns = OPTIONAL_COLUMNS
    .filter((key) => config.columns[key] && !header.includes(config.columns[key]))
    .map((key) => `${key} (${config.columns[key]})`)

  return { path, rows, absentColumns }
}
