/**
 * Tests de la etapa 3: el prompt y, sobre todo, la validación del borrador.
 *
 * Cada regla que valida `lib/seo.js` sale de una del artículo de Shopify, y
 * cada una tiene aquí su test: si el modelo mete keyword stuffing, un año que el
 * fichero no dice, lenguaje promocional en el feed o un texto calcado de otra
 * ficha, tiene que rebotar. El modelo se simula: lo que se prueba es el filtro,
 * que es la parte que puede fallar en silencio.
 *
 * @module dsh-plugin-catalog-agent/test/seo
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildCatalog, loadConfig } from '../lib/catalog.js'
import { buildPrompt, keywords, parseDraft, slugify, stripTags, validateDraft } from '../lib/seo.js'
import { CONFIG, FIXTURE, conCatalogoCargado, configTemporal, ejecucion, llmSimulado, registrar } from './helpers.js'

const config = loadConfig(CONFIG)
const { catalog } = buildCatalog(config, { path: FIXTURE })
const producto = (sku) => catalog.items.find((item) => item.sku === sku)

/** Un tinto de Rioja del fixture: `Vino tinto`, `Rioja`, `75 cl`. */
const TINTO = producto('000101')

/** Un borrador que cumple todas las reglas, del que parten los tests. */
const VALIDO = {
  seoTitle: 'Ejemplo Tinto Crianza, vino tinto de Rioja',
  seoDescription: 'Vino tinto de Rioja con crianza en barrica, para una comida de domingo sin complicaciones.',
  bodyHtml: '<p>Un vino tinto de Rioja con paso por barrica, para cuando apetece algo con cuerpo sin salir de lo conocido.</p>'
    + '<ul><li>Crianza en barrica: más redondo y menos aspero</li>'
    + '<li>Botella de 75 cl, la medida para compartir</li>'
    + '<li>De Rioja, la denominacion mas reconocible</li></ul>',
  handle: 'ejemplo-tinto-crianza-rioja',
  altText: 'Botella de Ejemplo Tinto Crianza sobre fondo claro',
  feedDescription: 'Vino tinto de Rioja con crianza en barrica. Botella de 75 cl.',
}

/** El borrador válido con un campo cambiado. */
const con = (cambios) => ({ ...VALIDO, ...cambios })

/** Los problemas que encuentra la validación, con el catálogo vacío de fondo. */
const problemas = (draft, product = TINTO, usados = {}) => validateDraft(draft, product, config, usados)

test('el borrador de referencia pasa todas las reglas', () => {
  assert.deepEqual(problemas(VALIDO), [])
})

test('slugify deja un handle limpio y sin acentos', () => {
  assert.equal(slugify('Viña Tondonia Reserva 75 cl'), 'vina-tondonia-reserva-75-cl')
  assert.equal(slugify('JEREZ-XÉRÈS-SHERRY'), 'jerez-xeres-sherry')
  // Corta por guión para no partir una palabra a medias.
  assert.equal(slugify('uno dos tres cuatro cinco', 13), 'uno-dos-tres')
})

test('las keywords salen de los datos del producto, no de ninguna parte', () => {
  assert.deepEqual(keywords(TINTO, config), ['Vino tinto', 'Rioja', '75 cl'])
  // Un producto sin denominación no inventa una.
  assert.ok(!keywords(producto('000112'), config).includes('Rioja'))
  // El código del ERP se traduce: al modelo no le llega `ECOLOGICO`.
  const ecologico = keywords(producto('000102'), config)
  assert.ok(ecologico.includes('ecológico'), ecologico.join(', '))
  assert.ok(!ecologico.includes('ECOLOGICO'))
})

test('al modelo no le llegan códigos del ERP, sino texto legible', () => {
  const { user } = buildPrompt(producto('000102'), config)
  assert.match(user, /"productionType": "ecológico"/)
  assert.ok(!user.includes('ECOLOGICO'), 'el código en mayúsculas acabaría escrito en la ficha')
})

test('el prompt lleva los límites de la configuración, no números escritos a mano', () => {
  const { system, user } = buildPrompt(TINTO, config)
  assert.match(system, new RegExp(String(config.description.seoDescription.maxChars)))
  assert.match(system, new RegExp(String(config.description.bodyHtml.bullets.max)))
  assert.match(system, /keyword stuffing/i)
  // Solo ve los campos declarados: ni precio, ni coste, ni proveedor.
  assert.match(user, /Vino tinto/)
  assert.ok(!user.includes(String(TINTO.cost)), 'el coste no puede llegar al modelo')
  assert.ok(!user.includes('supplierCode'))
})

test('el prompt de un reintento lleva lo que hay que corregir', () => {
  const { user } = buildPrompt(TINTO, config, ['seoTitle tiene 80 caracteres y el máximo es 60'])
  assert.match(user, /Corrige exactamente esto/)
  assert.match(user, /80 caracteres/)
})

test('parseDraft aguanta que el modelo envuelva el JSON', () => {
  const esperado = JSON.stringify(VALIDO)
  assert.equal(parseDraft(esperado).handle, VALIDO.handle)
  assert.equal(parseDraft('```json\n' + esperado + '\n```').handle, VALIDO.handle)
  assert.equal(parseDraft('Aquí tienes la ficha:\n' + esperado + '\nEspero que sirva.').handle, VALIDO.handle)
  assert.throws(() => parseDraft('lo siento, no puedo'), /ningún objeto JSON/)
  assert.throws(() => parseDraft('{ roto'), /no es JSON válido/)
})

test('exige los seis campos', () => {
  const sin = { ...VALIDO }
  delete sin.altText
  assert.deepEqual(problemas(sin), ['falta altText'])
})

test('respeta las longitudes de cada campo', () => {
  assert.match(problemas(con({ seoTitle: 'x'.repeat(61) }))[0], /seoTitle tiene 61 caracteres/)
  assert.match(problemas(con({ seoDescription: 'corta' }))[0], /mínimo es 70/)
  assert.match(problemas(con({ altText: 'x'.repeat(126) }))[0], /altText tiene 126/)
})

test('el handle tiene que ser un slug y no puede repetirse', () => {
  assert.match(problemas(con({ handle: 'Ejemplo Tinto' }))[0], /no vale: solo minúsculas/)
  assert.match(problemas(con({ handle: 'doble--guion' }))[0], /no vale/)
  const usados = { handles: new Set(['ejemplo-tinto-crianza-rioja']) }
  assert.match(problemas(VALIDO, TINTO, usados)[0], /ya lo tiene otro producto/)
})

test('el cuerpo tiene que poder escanearse: párrafo y luego bullets', () => {
  assert.match(problemas(con({ bodyHtml: '<p>Un vino tinto sin más.</p>' }))[0], /no trae el <ul>/)
  assert.match(problemas(con({ bodyHtml: '<ul><li>Un vino tinto</li></ul>' }))[0], /no trae el <p>/)
  const dosBullets = '<p>Un vino tinto de Rioja.</p><ul><li>Uno</li><li>Dos</li></ul>'
  assert.match(problemas(con({ bodyHtml: dosBullets }))[0], /hay 2 bullets/)
})

test('rechaza el párrafo de entrada demasiado largo', () => {
  const largo = `<p>Un vino tinto ${'palabra '.repeat(40)}.</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>`
  assert.match(problemas(con({ bodyHtml: largo })).join(' '), /palabras y el máximo es 40/)
})

test('rechaza un bullet kilométrico y las etiquetas no permitidas', () => {
  const bullet = `<p>Un vino tinto de Rioja.</p><ul><li>${'x'.repeat(91)}</li><li>Dos</li><li>Tres</li></ul>`
  assert.match(problemas(con({ bodyHtml: bullet })).join(' '), /91 caracteres y el máximo es 90/)
  const script = '<p>Un vino tinto de Rioja.</p><script>alert(1)</script><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>'
  assert.match(problemas(con({ bodyHtml: script })).join(' '), /<script>, que no está permitida/)
})

test('la primera frase tiene que decir qué es el producto', () => {
  const vaga = '<p>Una joya que no te puedes perder.</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>'
  assert.match(problemas(con({ bodyHtml: vaga })).join(' '), /no dice qué es el producto/)
})

test('dos fichas no pueden compartir el texto', () => {
  const usados = { textos: new Set([`bodyHtml:${VALIDO.bodyHtml}`]) }
  assert.match(problemas(VALIDO, TINTO, usados).join(' '), /idéntico al de otro producto/)
})

test('fuera el lenguaje promocional, que el feed de Merchant Center no lo admite', () => {
  const promo = con({ feedDescription: 'Vino tinto de Rioja. Envío gratis y el mejor precio.' })
  const encontrados = problemas(promo).join(' ')
  assert.match(encontrados, /envío gratis/)
  assert.match(encontrados, /mejor precio/)
})

test('no se puede inventar una añada, una graduación ni un premio', () => {
  assert.match(problemas(con({ seoTitle: 'Ejemplo Tinto Crianza 2019' })).join(' '), /"2019" no está en los datos/)
  assert.match(problemas(con({ altText: 'Botella de tinto de 13,5 grados' })).join(' '), /no está en los datos/)
  assert.match(problemas(con({ seoDescription: 'Vino tinto de Rioja premiado con medalla de oro en el concurso de la region.' })).join(' '), /no está en los datos/)
})

test('pero un dato que SÍ está en el nombre del producto no es invención', () => {
  const conAño = { ...producto('000101'), titleRaw: 'EJEMPLO TINTO CRIANZA 2019 75 cl.', title: 'Ejemplo Tinto Crianza 2019' }
  assert.deepEqual(problemas(con({ seoTitle: 'Ejemplo Tinto Crianza 2019' }), conAño), [])
})

test('detecta el keyword stuffing', () => {
  const repetido = '<p>Un vino tinto de Rioja de verdad.</p>'
    + '<ul><li>Vino tinto de Rioja</li><li>Vino tinto con crianza</li>'
    + '<li>Vino tinto para la mesa</li><li>Otro vino tinto mas</li></ul>'
  assert.match(problemas(con({ bodyHtml: repetido })).join(' '), /"Vino tinto" aparece 5 veces/)
})

test('stripTags deja el texto limpio', () => {
  assert.equal(stripTags('<p>Hola  <strong>mundo</strong></p>'), 'Hola mundo')
})

// ── el tool ─────────────────────────────────────────────────────────────────

test('catalog_describe no procesa nada si no le acotas el lote', async () => {
  const { tools } = await conCatalogoCargado(llmSimulado([]).llm)
  await assert.rejects(() => tools.catalog_describe.execute({}, ejecucion()), /Acota el lote|acota el lote/i)
})

test('catalog_describe exige que se haya cargado el catálogo antes', async () => {
  const { catalog_describe: tool } = registrar(configTemporal(), llmSimulado([]).llm)
  await assert.rejects(() => tool.execute({ limit: 1 }, ejecucion()), /no hay catálogo cargado/)
})

test('catalog_describe respeta el techo por llamada', async () => {
  const { tools } = await conCatalogoCargado(llmSimulado([]).llm, (c) => { c.description.maxPerCall = 2 })
  await assert.rejects(() => tools.catalog_describe.execute({ limit: 5 }, ejecucion()), /techo por llamada es 2/)
})

test('catalog_describe avisa de un sku que no existe', async () => {
  const { tools } = await conCatalogoCargado(llmSimulado([]).llm)
  await assert.rejects(() => tools.catalog_describe.execute({ sku: 'NO-EXISTE' }, ejecucion()), /no están en el catálogo/)
})

test('la prueba en seco devuelve el prompt sin llamar al modelo', async () => {
  const simulado = llmSimulado([])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const resultado = await tools.catalog_describe.execute({ limit: 1, dryRun: true }, ejecucion())
  assert.equal(simulado.llamadas.length, 0, 'no debería haber llamado al modelo')
  assert.match(resultado.prompt.system, /Responde SOLO con un objeto JSON/)
  assert.equal(resultado.generados, 0)
})

test('catalog_describe escribe la ficha y la deja SIN revisar', async () => {
  const simulado = llmSimulado([JSON.stringify(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const resultado = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(resultado.generados, 1)
  assert.equal(resultado.fallidos, 0)
  assert.equal(resultado.muestra[0].reviewed, false, 'nace sin revisar')
  assert.equal(resultado.muestra[0].model, 'deepseek/deepseek-chat')
  assert.equal(resultado.muestra[0].attempts, 1)
  assert.equal(resultado.sinRevisar, 1)

  const escrito = JSON.parse(readFileSync(resultado.outputPath, 'utf8'))
  assert.equal(escrito.items['000101'].handle, VALIDO.handle)

  // El modelo recibió el modelo de la sesión, no uno cableado.
  assert.equal(simulado.llamadas[0].provider, 'deepseek')
  assert.equal(simulado.llamadas[0].model, 'deepseek-chat')
})

test('un borrador inválido se devuelve al modelo para que se corrija', async () => {
  const malo = JSON.stringify(con({ seoTitle: 'x'.repeat(80) }))
  const simulado = llmSimulado([malo, JSON.stringify(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const resultado = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(resultado.generados, 1)
  assert.equal(resultado.muestra[0].attempts, 2, 'necesitó un segundo intento')
  assert.match(simulado.llamadas[1].messages[0].content[0].text, /80 caracteres/)
})

test('si agota los intentos, lo reporta en vez de guardar basura', async () => {
  const malo = JSON.stringify(con({ handle: 'MAL HANDLE' }))
  const simulado = llmSimulado([malo, malo, malo, malo])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const resultado = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(resultado.generados, 0)
  assert.equal(resultado.fallidos, 1)
  assert.equal(resultado.fallos[0].sku, '000101')
  assert.match(resultado.fallos[0].problemas.join(' '), /no vale: solo minúsculas/)
  const escrito = JSON.parse(readFileSync(resultado.outputPath, 'utf8'))
  assert.equal(escrito.items['000101'], undefined, 'no se guarda una ficha que no pasó')
})

test('el tool falla claro si no sabe con qué modelo redactar', async () => {
  const { tools } = await conCatalogoCargado(llmSimulado([]).llm)
  await assert.rejects(
    () => tools.catalog_describe.execute({ sku: '000101' }, { agent: { options: {} }, signal: AbortSignal.timeout(1000) }),
    /modelo de esta sesión/,
  )
})

test('catalog_review es lo que convierte una ficha en publicable', async () => {
  const simulado = llmSimulado([JSON.stringify(VALIDO)])
  const { tools, configPath } = await conCatalogoCargado(simulado.llm)
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  const { catalog_review: revisar } = registrar(configPath)
  await assert.rejects(() => revisar.execute({}), /di qué revisar/)

  const resultado = await revisar.execute({ sku: '000101' })
  assert.equal(resultado.revisadas, 1)
  assert.equal(resultado.sinRevisar, 0)

  const otra = await revisar.execute({ sku: '000101' })
  assert.equal(otra.revisadas, 0)
  assert.equal(otra.yaEstaban, 1)

  const inexistente = await revisar.execute({ sku: 'NO-EXISTE' })
  assert.deepEqual(inexistente.sinFicha, ['NO-EXISTE'])
})
