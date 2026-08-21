import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildCatalog, listSources, loadConfig, resolveSourcePath } from '../lib/catalog.js'
import { CONFIG, FIXTURE, configTemporal, registrar, temporal } from './helpers.js'

const config = loadConfig(CONFIG)
const { catalog, summary } = buildCatalog(config, { path: FIXTURE })
const porSku = new Map(catalog.items.map((producto) => [producto.sku, producto]))

/** El producto del fixture con ese SKU, ya normalizado. */
const producto = (sku) => {
  const encontrado = porSku.get(sku)
  assert.ok(encontrado, `el fixture debería traer el sku ${sku}`)
  return encontrado
}

/** Los códigos de aviso de un producto. */
const avisos = (sku) => producto(sku).warnings.map((aviso) => aviso.code)

/** La fila rechazada con ese SKU. */
const rechazo = (sku) => catalog.rejected.find((fila) => fila.sku === sku)

test('la configuración de la tienda es válida', () => {
  assert.equal(config.source.format, 'csv')
  assert.equal(config.columns.sku, 'Nº')
  assert.ok(config.taxonomy.groups.TINTO.productType)
})

test('una configuración sin una columna obligatoria falla diciendo cuál', () => {
  assert.throws(
    () => loadConfig(configTemporal((c) => { delete c.columns.price })),
    /columns\.price/,
  )
})

test('una configuración que no es de un CSV falla antes de leer nada', () => {
  assert.throws(
    () => loadConfig(configTemporal((c) => { c.source.format = 'xlsx' })),
    /solo lee CSV/,
  )
})

test('un fichero que no trae las columnas declaradas falla nombrándolas', () => {
  const ajeno = join(temporal(), 'otro-cliente.csv')
  writeFileSync(ajeno, 'Item Code,Retail EUR,Qty\nA1,10.00,3\n', 'utf8')
  assert.throws(
    () => buildCatalog(config, { path: ajeno }),
    /no trae las columnas que declara la configuración: Nº, Descripción/,
  )
})

test('reparte todas las filas entre productos y rechazos, sin perder ninguna', () => {
  assert.equal(summary.total, 22)
  assert.equal(summary.ok, 18)
  assert.equal(summary.rechazados, 4)
  assert.equal(summary.ok + summary.rechazados + summary.omitidosPorFecha, summary.total)
  assert.equal(catalog.items.length, summary.ok)
})

test('rechaza lo que no se puede publicar, con el motivo y la línea', () => {
  assert.match(rechazo('000113').reason, /price: valor no numérico "#N\/A"/)
  assert.match(rechazo('000114').reason, /grupo "MAGNUM" no declarado/)
  assert.match(rechazo('000116').reason, /stock: valor no entero "muchas"/)
  const sinSku = catalog.rejected.find((fila) => fila.sku === null)
  assert.match(sinSku.reason, /sku vacío/)
  assert.equal(sinSku.row, 16)
})

test('separa el formato del envase en todas las variantes del fichero', () => {
  for (const sku of ['000101', '000107', '000108', '000111']) {
    assert.equal(producto(sku).format, '75 cl', `sku ${sku}`)
    assert.equal(producto(sku).volumeMl, 750, `sku ${sku}`)
  }
  assert.deepEqual(
    [producto('000109').format, producto('000109').volumeMl],
    ['1,5 L', 1500],
  )
  assert.deepEqual(
    [producto('000110').format, producto('000110').volumeMl],
    ['37,5 cl', 375],
  )
})

test('avisa en vez de inventarlo cuando el título no trae formato', () => {
  assert.equal(producto('000106').format, null)
  assert.equal(producto('000106').volumeMl, null)
  assert.ok(avisos('000106').includes('sinFormato'))
})

test('capitaliza el título dejando las palabras llanas y los números', () => {
  assert.equal(producto('000121').title, 'Ejemplo de la Casa Natural')
  assert.equal(producto('000106').title, 'Ejemplo Estuche 3 Botellas')
  assert.equal(producto('000101').title, 'Ejemplo Tinto Crianza')
  // El nombre del ERP se conserva para poder rastrear de dónde sale cada ficha.
  assert.equal(producto('000109').titleRaw, 'EJEMPLO MAGNUM 1,5 L.')
})

test('capitaliza las denominaciones compuestas', () => {
  assert.equal(producto('000120').origin, 'Châteauneuf-du-Pape')
  assert.equal(producto('000102').origin, 'Penedés')
})

test('lee los números con el formato local del ERP', () => {
  assert.equal(producto('000101').price, 9.5)
  assert.equal(producto('000101').cost, 5.85)
  // "  1.250,00 € ": el punto agrupa millares, la coma es el decimal.
  assert.equal(producto('000120').price, 1250)
  assert.equal(producto('000103').stock, 8)
})

test('avisa del coste ilegible sin tirar el producto', () => {
  assert.equal(producto('000117').cost, null)
  assert.equal(producto('000117').price, 9)
  assert.ok(avisos('000117').includes('costeInvalido'))
})

test('convierte la fecha del ERP a ISO y avisa si no existe', () => {
  assert.equal(producto('000101').modifiedAt, '2026-01-09')
  // 31 de febrero: el ERP la escribe, el calendario no la tiene.
  assert.equal(producto('000118').modifiedAt, null)
  assert.ok(avisos('000118').includes('fechaInvalida'))
})

test('un flag de bloqueo que no entiende se trata como bloqueado', () => {
  assert.equal(producto('000101').blocked, false)
  assert.equal(producto('000106').blocked, true)
  assert.equal(producto('000119').blocked, true)
  assert.ok(avisos('000119').includes('bloqueoDesconocido'))
})

test('traduce el grupo del ERP al tipo de producto con el que se categoriza', () => {
  assert.equal(producto('000101').productType, 'Vino tinto')
  assert.equal(producto('000105').productType, 'Vino sin alcohol')
  assert.equal(producto('000106').productType, 'Estuche')
  assert.equal(producto('000120').productType, 'Vino de importación')
  // El código del ERP se conserva por si hay que volver al fichero.
  assert.equal(producto('000105').group, 'SIN ALCOHO')
})

test('compone los tags con el origen, la elaboración y el grupo', () => {
  assert.deepEqual(producto('000102').tags, ['Penedés', 'ecológico'])
  assert.deepEqual(producto('000120').tags, ['Châteauneuf-du-Pape', 'importación'])
  // Una elaboración que la taxonomía no traduce se publica tal cual.
  assert.deepEqual(producto('000122').tags, ['Alella', 'ANFORA'])
  assert.deepEqual(producto('000112').tags, [])
  assert.ok(avisos('000112').includes('sinOrigen'))
})

test('no publica el código interno de proveedor como marca', () => {
  assert.equal(producto('000103').supplierCode, 'PRO000003')
  assert.equal(producto('000103').vendor, null)
})

test('modifiedSince deja fuera lo que el ERP no ha tocado', () => {
  const incremental = buildCatalog(config, { path: FIXTURE, modifiedSince: '2026-02-10' })
  assert.ok(incremental.summary.omitidosPorFecha > 0)
  assert.equal(
    incremental.summary.ok + incremental.summary.rechazados + incremental.summary.omitidosPorFecha,
    incremental.summary.total,
  )
  for (const item of incremental.catalog.items) {
    // Sin fecha legible no se puede afirmar que no haya cambiado: entra.
    if (item.modifiedAt) assert.ok(item.modifiedAt >= '2026-02-10', `${item.sku} ${item.modifiedAt}`)
  }
})

test('la bandeja de entrada dice qué hay y si sirve', () => {
  const bandeja = temporal()
  // Uno bueno: el fixture entero.
  const bueno = join(bandeja, 'cliente-bueno.csv')
  writeFileSync(bueno, readFileSync(FIXTURE, 'utf8'), 'utf8')
  // Uno con la cabecera de otro ERP.
  writeFileSync(join(bandeja, 'cliente-ajeno.csv'), 'Item Code,Retail EUR,Qty\nA1,10.00,3\n', 'utf8')
  // Uno que no es un CSV.
  writeFileSync(join(bandeja, 'precios.xlsx'), 'no soy un csv', 'utf8')
  // Los ocultos no cuentan.
  writeFileSync(join(bandeja, '.DS_Store'), '', 'utf8')

  const config = loadConfig(configTemporal((c) => { c.source.dirs = [bandeja] }))
  const { dirs, files } = listSources(config)
  assert.deepEqual(dirs, [{ dir: bandeja, existe: true }])
  assert.deepEqual(files.map((f) => f.name), ['cliente-ajeno.csv', 'cliente-bueno.csv', 'precios.xlsx'])

  const porNombre = new Map(files.map((f) => [f.name, f]))
  assert.equal(porNombre.get('cliente-bueno.csv').compatible, true)
  assert.equal(porNombre.get('cliente-bueno.csv').rows, 22)
  assert.equal(porNombre.get('cliente-ajeno.csv').compatible, false)
  assert.match(porNombre.get('cliente-ajeno.csv').problema, /no trae las columnas/)
  assert.match(porNombre.get('precios.xlsx').problema, /no es un \.csv/)
})

test('una bandeja que no existe no es un error, solo está vacía', () => {
  const config = loadConfig(configTemporal((c) => { c.source.dirs = ['/no/existe/esta/ruta'] }))
  const { dirs, files } = listSources(config)
  assert.deepEqual(dirs, [{ dir: '/no/existe/esta/ruta', existe: false }])
  assert.deepEqual(files, [])
})

test('basta el nombre del fichero si está en la bandeja, con extensión o sin ella', () => {
  const bandeja = temporal()
  writeFileSync(join(bandeja, 'cliente-x.csv'), readFileSync(FIXTURE, 'utf8'), 'utf8')
  const config = loadConfig(configTemporal((c) => { c.source.dirs = [bandeja] }))

  assert.equal(resolveSourcePath(config, 'cliente-x.csv'), join(bandeja, 'cliente-x.csv'))
  assert.equal(resolveSourcePath(config, 'cliente-x'), join(bandeja, 'cliente-x.csv'))
  // Sin pedir nada, el catálogo habitual de la tienda.
  assert.equal(resolveSourcePath(config), FIXTURE)
  // Una ruta absoluta se respeta tal cual.
  assert.equal(resolveSourcePath(config, FIXTURE), FIXTURE)
})

test('catalog_load carga por nombre y dice de qué fichero salió', async () => {
  const bandeja = temporal()
  writeFileSync(join(bandeja, 'cliente-x.csv'), readFileSync(FIXTURE, 'utf8'), 'utf8')
  const { catalog_load: tool } = registrar(configTemporal((c) => { c.source.dirs = [bandeja] }))

  const resultado = await tool.execute({ path: 'cliente-x' })
  assert.equal(resultado.sourcePath, join(bandeja, 'cliente-x.csv'))
  assert.equal(resultado.ok, 18)
})

test('busca en varias carpetas, en orden, y expande ~', () => {
  const primera = temporal()
  const segunda = temporal()
  writeFileSync(join(segunda, 'solo-en-la-segunda.csv'), readFileSync(FIXTURE, 'utf8'), 'utf8')
  const config = loadConfig(configTemporal((c) => { c.source.dirs = [primera, segunda] }))

  assert.equal(resolveSourcePath(config, 'solo-en-la-segunda'), join(segunda, 'solo-en-la-segunda.csv'))
  const { dirs } = listSources(config)
  assert.deepEqual(dirs.map((d) => d.dir), [primera, segunda])

  // `~` es el home, no una carpeta llamada "~".
  const conTilde = loadConfig(configTemporal((c) => { c.source.dirs = ['~/no-existe-esta-carpeta'] }))
  assert.equal(listSources(conTilde).dirs[0].dir, join(homedir(), 'no-existe-esta-carpeta'))
})

test('cuando no encuentra un fichero dice dónde ha buscado', () => {
  const bandeja = temporal()
  const config = loadConfig(configTemporal((c) => { c.source.dirs = [bandeja] }))
  assert.throws(
    () => buildCatalog(config, { path: 'no-existe' }),
    (error) => error.message.includes('He buscado en') && error.message.includes(bandeja)
      && error.message.includes('catalog_sources'),
  )
})

test('catalog_sources incluye el catálogo habitual, no solo la bandeja', async () => {
  const { catalog_sources: tool } = registrar(configTemporal((c) => { c.source.dirs = [temporal()] }))
  const resultado = await tool.execute({})
  assert.equal(resultado.habitual, FIXTURE)
  assert.deepEqual(resultado.files, [])
})

test('el plugin registra las herramientas del pipeline', () => {
  const registradas = registrar(configTemporal())
  assert.deepEqual(
    Object.keys(registradas).sort(),
    ['catalog_describe', 'catalog_load', 'catalog_review', 'catalog_seo', 'catalog_sources'],
  )
})

test('el tool escribe el catálogo completo y devuelve solo el resumen', async () => {
  const { catalog_load: tool } = registrar(configTemporal())
  const resultado = await tool.execute({})

  assert.equal(resultado.ok, 18)
  assert.equal(resultado.producto, null)
  assert.ok(resultado.muestra.length <= 2, 'la muestra va acotada')
  assert.equal(resultado.items, undefined, 'los productos no viajan en el resultado')

  const escrito = JSON.parse(readFileSync(resultado.outputPath, 'utf8'))
  assert.equal(escrito.items.length, 18)
  assert.equal(escrito.rejected.length, 4)
  assert.equal(escrito.source.rows, 22)

  // El resultado tiene que caber por debajo del podador del preset.
  const informe = tool.output.render({}, resultado)[0].text
  assert.ok(informe.length < 8192, `el informe ocupa ${informe.length} caracteres`)
})

test('el tool devuelve un producto concreto por sku', async () => {
  const { catalog_load: tool } = registrar(configTemporal())
  const resultado = await tool.execute({ sku: '000109' })
  assert.equal(resultado.producto.title, 'Ejemplo Magnum')
  assert.equal(resultado.producto.volumeMl, 1500)
})

test('el tool explica por qué un sku rechazado no está en el catálogo', async () => {
  const { catalog_load: tool } = registrar(configTemporal())
  await assert.rejects(
    () => tool.execute({ sku: '000113' }),
    /se ha rechazado \(línea 14\).*#N\/A/s,
  )
  await assert.rejects(() => tool.execute({ sku: 'NO-EXISTE' }), /no está en/)
})

test('el tool rechaza una fecha mal escrita en modifiedSince', async () => {
  const { catalog_load: tool } = registrar(configTemporal())
  await assert.rejects(() => tool.execute({ modifiedSince: '10/2/2026' }), /aaaa-mm-dd/)
})
