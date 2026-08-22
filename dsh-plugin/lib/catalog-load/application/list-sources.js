/**
 * Aplicación del listado de fuentes: qué ficheros hay para cargar.
 *
 * dsh no admite adjuntar un CSV al chat, así que señalar la entrada es señalar un
 * fichero del disco. Esto dice qué hay en las bandejas y si cada uno encaja con el
 * mapeo de columnas del cliente, para poder elegir sobre lo que existe.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/application/list-sources
 */

import { resolveFromConfig } from '../../config.js'
import { listSources } from '../infra/csv-source.js'

/**
 * Las fuentes disponibles, con el catálogo habitual señalado.
 * @param dominio - la configuración cargada.
 * @returns las bandejas, los ficheros que hay en ellas y el habitual.
 */
export function listCatalogSources(dominio) {
  const { dirs, files } = listSources(dominio)
  return { dirs, files, habitual: resolveFromConfig(dominio, dominio.source.path) }
}
