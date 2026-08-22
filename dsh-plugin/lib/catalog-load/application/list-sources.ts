/**
 * Aplicación del listado de fuentes: qué ficheros hay para cargar.
 *
 * dsh no admite adjuntar un CSV al chat, así que señalar la entrada es señalar un
 * fichero del disco. Esto dice qué hay en las bandejas y si cada uno encaja con el
 * mapeo de columnas del cliente, para poder elegir sobre lo que existe.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/application/list-sources
 */

import { resolveFromConfig, type CatalogConfig } from '../../config.ts'
import { listSources } from '../infra/csv-source.ts'

/**
 * Las fuentes disponibles, con el catálogo habitual señalado.
 * @param dominio - la configuración cargada.
 * @returns las bandejas, los ficheros que hay en ellas y el habitual.
 */
export function listCatalogSources(domainConfig: CatalogConfig) {
  const { dirs, files } = listSources(domainConfig)
  return { dirs, files, defaultSource: resolveFromConfig(domainConfig, domainConfig.source.path) }
}
