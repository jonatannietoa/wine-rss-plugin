/**
 * Aplicación de la carga: orquesta fichero → dominio → JSON.
 *
 * Lee las filas por el adaptador de entrada, las convierte a productos con el
 * dominio y saca el resultado por el adaptador de salida. Qué fila es publicable
 * y qué fila se rechaza lo dice el dominio, no esta capa.
 *
 * @module dsh-plugin-catalog-agent/catalog-load/application/load-catalog
 */

import { normalizeRow } from '../../domain/product.js'
import { readRows } from '../infra/csv-source.js'
import { guardarCatalogo } from '../infra/catalog-store.js'

/**
 * Recorre el fichero entero y reparte las filas entre productos y rechazos.
 * @param config - la configuración cargada.
 * @param opciones - `path` para leer otro fichero y `modifiedSince` (`aaaa-mm-dd`)
 *   para procesar solo lo que cambió en el ERP desde esa fecha.
 * @returns `{ catalog, summary }`: el catálogo completo y el resumen acotado que
 *   se le puede enseñar al modelo.
 */
export function buildCatalog(config, opciones = {}) {
  const { path, rows, columnasAusentes } = readRows(config, opciones.path)
  const desde = opciones.modifiedSince ? String(opciones.modifiedSince).slice(0, 10) : null

  const items = []
  const rejected = []
  let omitidosPorFecha = 0

  rows.forEach((row, indice) => {
    // +2: la cabecera es la línea 1 y las filas se cuentan desde 1.
    const resultado = normalizeRow(row, config, indice + 2)
    if (resultado.rejected) {
      rejected.push(resultado.rejected)
      return
    }
    // Sin fecha legible no se puede afirmar que no haya cambiado: entra.
    if (desde && resultado.product.modifiedAt && resultado.product.modifiedAt < desde) {
      omitidosPorFecha += 1
      return
    }
    items.push(resultado.product)
  })

  const contar = (valores) => {
    const cuenta = new Map()
    for (const valor of valores) cuenta.set(valor, (cuenta.get(valor) ?? 0) + 1)
    return [...cuenta].sort((a, b) => b[1] - a[1])
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
      rechazados: rejected.length,
      omitidosPorFecha,
      porGrupo: contar(items.map((item) => item.productType))
        .map(([productType, count]) => ({ productType, count })),
      avisos: contar(items.flatMap((item) => item.warnings.map((aviso) => aviso.code)))
        .map(([code, count]) => ({ code, count })),
      columnasAusentes,
      // Acotados a propósito: el resultado del tool tiene que caber por debajo
      // del podador del preset (8192 caracteres).
      rechazos: rejected.slice(0, 10),
      muestra: items.slice(0, 2),
    },
  }
}

/**
 * Carga el catálogo y lo deja escrito.
 * @param dominio - la configuración cargada.
 * @param args - lo que pidió quien llama: `path`, `modifiedSince`, `sku`.
 * @returns el resumen, el producto pedido si lo hubo, y dónde ha quedado.
 */
export function loadCatalog(dominio, args = {}) {
  if (args.modifiedSince && !/^\d{4}-\d{2}-\d{2}$/.test(args.modifiedSince.trim())) {
    throw new Error(`modifiedSince debe ser una fecha aaaa-mm-dd (recibido "${args.modifiedSince}")`)
  }

  const { catalog, summary } = buildCatalog(dominio, {
    // La resolución la hace `resolveSourcePath`: nombre suelto en la bandeja
    // de entrada, relativa contra el directorio de la sesión, absoluta tal cual.
    path: args.path?.trim() || undefined,
    modifiedSince: args.modifiedSince?.trim() || undefined,
  })

  const outputPath = guardarCatalogo(dominio, catalog)

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
