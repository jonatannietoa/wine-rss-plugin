/**
 * Aplicación de la carga: orquesta fichero → dominio → JSON.
 *
 * Lee las filas por el adaptador de entrada, las convierte a productos con el
 * dominio y saca el resultado por el adaptador de salida. Qué fila es publicable
 * y qué fila se rechaza lo dice el dominio, no esta capa.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/application/load-catalog
 */

import { normalizeRow } from '../../domain/product.ts'
import { readRows } from '../infra/csv-source.ts'
import { saveCatalog } from '../infra/catalog-store.ts'
import type { CatalogConfig } from '../../config.ts'

/** Lo que se le puede pedir a la carga. */
export interface LoadArgs {
  readonly path?: string
  readonly modifiedSince?: string
  readonly sku?: string
}

/**
 * Recorre el fichero entero y reparte las filas entre productos y rechazos.
 * @param config - la configuración cargada.
 * @param opciones - `path` para leer otro fichero y `modifiedSince` (`aaaa-mm-dd`)
 *   para procesar solo lo que cambió en el ERP desde esa fecha.
 * @returns `{ catalog, summary }`: el catálogo completo y el resumen acotado que
 *   se le puede enseñar al modelo.
 */
export function buildCatalog(config: CatalogConfig, options: { path?: string, modifiedSince?: string } = {}) {
  const { path, rows, absentColumns } = readRows(config, options.path)
  const from = options.modifiedSince ? String(options.modifiedSince).slice(0, 10) : null

  const items = []
  const rejected = []
  let skippedByDate = 0

  rows.forEach((row, index) => {
    // +2: la cabecera es la línea 1 y las filas se cuentan desde 1.
    const result = normalizeRow(row, config, index + 2)
    if (result.rejected) {
      rejected.push(result.rejected)
      return
    }
    // Sin fecha legible no se puede afirmar que no haya cambiado: entra.
    if (from && result.product.modifiedAt && result.product.modifiedAt < from) {
      skippedByDate += 1
      return
    }
    items.push(result.product)
  })

  const contar = (valores) => {
    const counts = new Map()
    for (const value of valores) counts.set(value, (counts.get(value) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1])
  }

  return {
    catalog: {
      generatedAt: new Date().toISOString(),
      source: { path, rows: rows.length },
      items,
      rejected,
    },
    summary: {
      total: rows.length,
      ok: items.length,
      rejected: rejected.length,
      skippedByDate,
      byProductType: contar(items.map((item) => item.productType))
        .map(([productType, count]) => ({ productType, count })),
      warnings: contar(items.flatMap((item) => item.warnings.map((aviso) => aviso.code)))
        .map(([code, count]) => ({ code, count })),
      absentColumns,
      // Acotados a propósito: el resultado del tool tiene que caber por debajo
      // del podador del preset (8192 caracteres).
      rejections: rejected.slice(0, 10),
      sample: items.slice(0, 2),
    },
  }
}

/**
 * Carga el catálogo y lo deja escrito.
 * @param dominio - la configuración cargada.
 * @param args - lo que pidió quien llama: `path`, `modifiedSince`, `sku`.
 * @returns el resumen, el producto pedido si lo hubo, y dónde ha quedado.
 */
export function loadCatalog(domainConfig: CatalogConfig, args: LoadArgs = {}) {
  if (args.modifiedSince && !/^\d{4}-\d{2}-\d{2}$/.test(args.modifiedSince.trim())) {
    throw new Error(`modifiedSince debe ser una fecha aaaa-mm-dd (recibido "${args.modifiedSince}")`)
  }

  const { catalog, summary } = buildCatalog(domainConfig, {
    // La resolución la hace `resolveSourcePath`: nombre suelto en la bandeja
    // de entrada, relativa contra el directorio de la sesión, absoluta tal cual.
    path: args.path?.trim() || undefined,
    modifiedSince: args.modifiedSince?.trim() || undefined,
  })

  const outputPath = saveCatalog(domainConfig, catalog)

  let producto = null
  if (args.sku) {
    const buscado = args.sku.trim()
    producto = catalog.items.find((item) => item.sku === buscado) ?? null
    if (!producto) {
      const rechazado = catalog.rejected.find((fila) => fila.sku === buscado)
      throw new Error(rechazado
        ? `el sku "${buscado}" está en el fichero pero se ha rechazado (línea ${rechazado.row}): ${rechazado.reason}`
        : `el sku "${buscado}" no está en ${catalog.source.path}`)
    }
  }

  return { outputPath, sourcePath: catalog.source.path, ...summary, producto }
}
