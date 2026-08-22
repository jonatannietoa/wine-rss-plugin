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
import { loadConfig } from '../lib/config.js'
import { buildCatalog } from '../lib/catalog-load/application/load-catalog.js'
import { SEO_FIELDS, keywords, slugify, stripTags, validateDraft } from '../lib/catalog-describe/domain/seo-draft.js'
import { parseBlocks } from '../lib/catalog-describe/infra/llm-adapter.js'
import { buildPrompt } from '../lib/catalog-describe/application/describe-catalog.js'
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

/** Un borrador en el formato de bloques que devuelve el modelo. */
const enBloques = (draft) => SEO_FIELDS.map((campo) => `### ${campo}\n${draft[campo]}`).join('\n\n')

/** Los mensajes de los problemas, que es lo que se le devuelve al modelo. */
const problems = (draft, product = TINTO, used = {}) =>
  validateDraft(draft, product, config, used).map((x) => x.message)

/** Los códigos de los problemas, que es con lo que se cuenta qué regla rechaza. */
const codes = (draft, product = TINTO, used = {}) =>
  validateDraft(draft, product, config, used).map((x) => x.code)

test('el borrador de referencia pasa todas las reglas', () => {
  assert.deepEqual(problems(VALIDO), [])
})

test('cada problema lleva un código estable, no solo un mensaje', () => {
  // Sin código no se puede contar qué regla cuesta llamadas.
  assert.deepEqual(codes(con({ seoTitle: 'x'.repeat(61) })), ['largo:seoTitle'])
  assert.deepEqual(codes(con({ handle: 'MAL HANDLE' })), ['handleInvalido'])
  const stuffing = '<p>Un vino tinto de Rioja.</p><ul><li>Vino tinto</li><li>Vino tinto</li>'
    + '<li>Vino tinto</li><li>Vino tinto</li></ul>'
  assert.ok(codes(con({ bodyHtml: stuffing })).includes('stuffing'))
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

test('parseBlocks saca los seis campos de los bloques', () => {
  const leido = parseBlocks(enBloques(VALIDO))
  for (const campo of SEO_FIELDS) assert.equal(leido[campo], VALIDO[campo], campo)
})

test('parseBlocks aguanta lo que el modelo añade de su cosecha', () => {
  const bloques = enBloques(VALIDO)
  // Un preámbulo antes del primer bloque.
  assert.equal(parseBlocks(`Claro, aquí tienes la ficha:\n\n${bloques}`).handle, VALIDO.handle)
  // Markdown de cercado alrededor.
  assert.equal(parseBlocks('```\n' + bloques + '\n```').handle, VALIDO.handle)
  // Cabeceras de otro nivel, con dos puntos, y alguna que no reconoce.
  assert.equal(parseBlocks(bloques.replace('### handle', '#### Handle:')).handle, VALIDO.handle)
  assert.equal(parseBlocks(`### notas\nlo que sea\n\n${bloques}`).seoTitle, VALIDO.seoTitle)
})

test('una respuesta truncada conserva lo que llegó completo', () => {
  // Esto es lo que pasó de verdad: se cortó dentro del cuerpo.
  const skipped = '### seoTitle\n' + VALIDO.seoTitle + '\n\n### bodyHtml\n<p>Un vino tinto de Rioja con paso por bar'
  const leido = parseBlocks(skipped)
  assert.equal(leido.seoTitle, VALIDO.seoTitle, 'lo completo se conserva')
  assert.match(leido.bodyHtml, /^<p>Un vino tinto/, 'lo parcial también, para poder verlo')
  assert.equal(leido.handle, '', 'lo que no llegó queda vacío')
  // Y la validación pide exactamente lo que falta, que es lo que se le devuelve al modelo.
  const missing = problems(leido).filter((p) => p.startsWith('falta '))
  assert.deepEqual(missing.sort(), ['falta altText', 'falta feedDescription', 'falta handle', 'falta seoDescription'])
})

test('una respuesta sin bloques dice qué llegó en su lugar', () => {
  assert.throws(() => parseBlocks(''), /está vacía/)
  assert.throws(() => parseBlocks('lo siento, no puedo'), /empieza por "lo siento, no puedo/)
})

test('exige los seis campos', () => {
  const sin = { ...VALIDO }
  delete sin.altText
  assert.deepEqual(problems(sin), ['falta altText'])
})

test('respeta las longitudes de cada campo', () => {
  assert.match(problems(con({ seoTitle: 'x'.repeat(61) }))[0], /seoTitle tiene 61 caracteres/)
  assert.match(problems(con({ seoDescription: 'corta' }))[0], /mínimo es 70/)
  assert.match(problems(con({ altText: 'x'.repeat(126) }))[0], /altText tiene 126/)
})

test('el handle tiene que ser un slug y no puede repetirse', () => {
  assert.match(problems(con({ handle: 'Ejemplo Tinto' }))[0], /no vale: solo minúsculas/)
  assert.match(problems(con({ handle: 'doble--guion' }))[0], /no vale/)
  const used = { handles: new Set(['ejemplo-tinto-crianza-rioja']) }
  assert.match(problems(VALIDO, TINTO, used)[0], /ya lo tiene otro producto/)
})

test('el cuerpo tiene que poder escanearse: párrafo y luego bullets', () => {
  assert.match(problems(con({ bodyHtml: '<p>Un vino tinto sin más.</p>' }))[0], /no trae el <ul>/)
  assert.match(problems(con({ bodyHtml: '<ul><li>Un vino tinto</li></ul>' }))[0], /no trae el <p>/)
  const dosBullets = '<p>Un vino tinto de Rioja.</p><ul><li>Uno</li><li>Dos</li></ul>'
  assert.match(problems(con({ bodyHtml: dosBullets }))[0], /hay 2 bullets/)
})

test('rechaza el párrafo de entrada demasiado largo', () => {
  const largo = `<p>Un vino tinto ${'word '.repeat(40)}.</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>`
  assert.match(problems(con({ bodyHtml: largo })).join(' '), /palabras y el máximo es 40/)
})

test('rechaza un bullet kilométrico y las etiquetas no permitidas', () => {
  const bullet = `<p>Un vino tinto de Rioja.</p><ul><li>${'x'.repeat(91)}</li><li>Dos</li><li>Tres</li></ul>`
  assert.match(problems(con({ bodyHtml: bullet })).join(' '), /91 caracteres y el máximo es 90/)
  const script = '<p>Un vino tinto de Rioja.</p><script>alert(1)</script><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>'
  assert.match(problems(con({ bodyHtml: script })).join(' '), /<script>, que no está permitida/)
})

test('la primera frase tiene que decir qué es el producto', () => {
  const vaga = '<p>Una joya que no te puedes perder.</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>'
  assert.match(problems(con({ bodyHtml: vaga })).join(' '), /no dice qué es el producto/)
})

test('un tipo de producto genérico se satisface con la categoría', () => {
  // El ERP traduce el grupo OTROS a productType "Otros", y exigir esa palabra
  // fuerza una frase que nadie escribiría: «es un otros».
  const otros = { ...TINTO, productType: 'Otros', category: 'VINO' }
  const natural = con({
    bodyHtml: '<p>Un vino generoso seco, para tomar frio antes de comer.</p>'
      + '<ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>',
  })
  assert.deepEqual(problems(natural, otros), [], 'nombra la categoría, y con eso basta')

  // Pero si no dice ni el tipo ni la categoría, sigue rebotando.
  const vaga = con({ bodyHtml: '<p>Una joya de la casa.</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>' })
  assert.match(problems(vaga, otros).join(' '), /no dice qué es el producto/)
  // Y el mensaje dice las tres cosas que valen, no solo la absurda.
  assert.match(problems(vaga, otros).join(' '), /"otros" o "vino"/)
})

test('el resumen dice cuánto se razonó como máximo, para ver si el presupuesto va justo', async () => {
  const llm = {
    async *stream() {
      yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(9000) }
      yield { type: 'text-delta', index: 0, text: enBloques(VALIDO) }
    },
  }
  const { tools } = await conCatalogoCargado(llm, (c) => { c.description.maxTokens = 16000 })
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())
  assert.equal(result.written, 1)
  assert.equal(result.peakReasoningChars, 9000, 'se ve aunque la ficha salga bien')
  assert.equal(result.maxTokens, 16000)
})

test('dos fichas no pueden compartir el texto', () => {
  const used = { texts: new Set([`bodyHtml:${VALIDO.bodyHtml}`]) }
  assert.match(problems(VALIDO, TINTO, used).join(' '), /idéntico al de otro producto/)
})

test('fuera el lenguaje promocional, que el feed de Merchant Center no lo admite', () => {
  const promo = con({ feedDescription: 'Vino tinto de Rioja. Envío gratis y el mejor precio.' })
  const encontrados = problems(promo).join(' ')
  assert.match(encontrados, /envío gratis/)
  assert.match(encontrados, /mejor precio/)
})

test('no se puede inventar una añada, una graduación ni un premio', () => {
  assert.match(problems(con({ seoTitle: 'Ejemplo Tinto Crianza 2019' })).join(' '), /"2019" no está en los datos/)
  assert.match(problems(con({ altText: 'Botella de tinto de 13,5 grados' })).join(' '), /no está en los datos/)
  assert.match(problems(con({ seoDescription: 'Vino tinto de Rioja premiado con medalla de oro en el concurso de la region.' })).join(' '), /no está en los datos/)
})

test('pero un dato que SÍ está en el nombre del producto no es invención', () => {
  const withVintage = { ...producto('000101'), titleRaw: 'EJEMPLO TINTO CRIANZA 2019 75 cl.', title: 'Ejemplo Tinto Crianza 2019' }
  assert.deepEqual(problems(con({ seoTitle: 'Ejemplo Tinto Crianza 2019' }), withVintage), [])
})

test('detecta el keyword stuffing', () => {
  const repetido = '<p>Un vino tinto de Rioja de verdad.</p>'
    + '<ul><li>Vino tinto de Rioja</li><li>Vino tinto con crianza</li>'
    + '<li>Vino tinto para la mesa</li><li>Otro vino tinto mas</li></ul>'
  assert.match(problems(con({ bodyHtml: repetido })).join(' '), /"Vino tinto" aparece 5 veces/)
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
  const result = await tools.catalog_describe.execute({ limit: 1, dryRun: true }, ejecucion())
  assert.equal(simulado.calls.length, 0, 'no debería haber llamado al modelo')
  assert.match(result.prompt.system, /### seoTitle/)
  assert.equal(result.written, 0)
})

test('catalog_describe escribe la ficha y la deja SIN revisar', async () => {
  const simulado = llmSimulado([enBloques(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(result.written, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.sample[0].reviewed, false, 'nace sin revisar')
  assert.equal(result.sample[0].model, 'deepseek/deepseek-chat')
  assert.equal(result.sample[0].attempts, 1)
  assert.equal(result.unreviewed, 1)

  const escrito = JSON.parse(readFileSync(result.outputPath, 'utf8'))
  assert.equal(escrito.items['000101'].handle, VALIDO.handle)

  // El modelo recibió el modelo de la sesión, no uno cableado.
  assert.equal(simulado.calls[0].provider, 'deepseek')
  assert.equal(simulado.calls[0].model, 'deepseek-chat')
})

test('un borrador inválido se devuelve al modelo para que se corrija', async () => {
  const malo = enBloques(con({ seoTitle: 'x'.repeat(80) }))
  const simulado = llmSimulado([malo, enBloques(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(result.written, 1)
  assert.equal(result.sample[0].attempts, 2, 'necesitó un segundo intento')
  assert.match(simulado.calls[1].messages[0].content[0].text, /80 caracteres/)
})

test('si agota los intentos, lo reporta en vez de guardar basura', async () => {
  const malo = enBloques(con({ handle: 'MAL HANDLE' }))
  const simulado = llmSimulado([malo, malo, malo, malo])
  const { tools } = await conCatalogoCargado(simulado.llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(result.written, 0)
  assert.equal(result.failed, 1)
  assert.equal(result.failures[0].sku, '000101')
  assert.match(result.failures[0].problems.join(' '), /no vale: solo minúsculas/)
  const escrito = JSON.parse(readFileSync(result.outputPath, 'utf8'))
  assert.equal(escrito.items['000101'], undefined, 'no se guarda una ficha que no pasó')
})

test('el tool falla claro si no sabe con qué modelo redactar', async () => {
  const { tools } = await conCatalogoCargado(llmSimulado([]).llm)
  await assert.rejects(
    () => tools.catalog_describe.execute({ sku: '000101' }, { agent: { options: {} }, signal: AbortSignal.timeout(1000) }),
    /modelo de esta sesión/,
  )
})

test('al modelo se le pasan el esfuerzo y el presupuesto de la configuración', async () => {
  const simulado = llmSimulado([enBloques(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm, (c) => {
    c.description.reasoningEffort = 'low'
    c.description.maxTokens = 4000
  })
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  const llamada = simulado.calls[0]
  // Esto es lo que falló en producción: 1500 cableado contra reasoningEffort high.
  assert.equal(llamada.reasoningEffort, 'low')
  assert.equal(llamada.maxTokens, 4000)
  assert.equal(llamada.temperature, undefined, 'sin valor en la configuración, manda el proveedor')
})

test('un fallo sistémico corta el lote en vez de repetirlo por producto', async () => {
  // El modelo no devuelve bloques nunca: es lo que pasó con reasoningEffort high.
  const enBlanco = Array(12).fill('')
  const { tools } = await conCatalogoCargado(llmSimulado(enBlanco).llm)
  const result = await tools.catalog_describe.execute({ limit: 4 }, ejecucion())

  assert.equal(result.written, 0)
  assert.equal(result.failed, 1, 'solo se intenta el primero')
  assert.equal(result.skipped, 3, 'los otros tres no se tocan')
  assert.match(result.failures[0].problems.join(' '), /está vacía/)
})

test('un fallo diagnosticable dice qué devolvió el modelo', async () => {
  // Cero texto y mucho razonamiento: el síntoma exacto del presupuesto agotado.
  const calls = []
  const llm = {
    async *stream(opciones) {
      calls.push(opciones)
      yield { type: 'reasoning-delta', index: 0, text: 'x'.repeat(1847) }
    },
  }
  const { tools } = await conCatalogoCargado(llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  const fallo = result.failures[0]
  assert.equal(fallo.textChars, 0)
  assert.equal(fallo.reasoningChars, 1847)
  assert.match(fallo.problems.join(' '), /gastó 1847 caracteres razonando y no escribió nada/)
  assert.match(fallo.problems.join(' '), /maxTokens.*reasoningEffort/s)
})

test('un fallo de validación no corta el lote: ese sí es del producto', async () => {
  // Devuelve bloques, pero con un handle inválido: el modelo funciona.
  const malo = enBloques(con({ handle: 'MAL HANDLE' }))
  const respuestas = [...Array(3).fill(malo), ...Array(3).fill(enBloques(VALIDO))]
  const { tools } = await conCatalogoCargado(llmSimulado(respuestas).llm)
  const result = await tools.catalog_describe.execute({ limit: 2 }, ejecucion())

  assert.equal(result.skipped, 0, 'sigue con el siguiente producto')
  assert.equal(result.failed, 1)
  assert.equal(result.written, 1)
})

test('el lote se redacta en paralelo, con el primero solo', async () => {
  // Cada respuesta con handle distinto, para que no haya colisión.
  const respuestas = ['a', 'b', 'c', 'd'].map((s) => enBloques(con({
    handle: `ficha-${s}`,
    seoDescription: `${VALIDO.seoDescription} Variante ${s} para que no se repita el texto.`,
    feedDescription: `${VALIDO.feedDescription} Variante ${s}.`,
    bodyHtml: VALIDO.bodyHtml.replace('paso por barrica', `paso por barrica ${s}`),
  })))

  const enVuelo = { ahora: 0, maxAllowed: 0 }
  const llm = {
    async *stream() {
      enVuelo.ahora += 1
      enVuelo.maxAllowed = Math.max(enVuelo.maxAllowed, enVuelo.ahora)
      await new Promise((listo) => setTimeout(listo, 20))
      enVuelo.ahora -= 1
      yield { type: 'text-delta', index: 0, text: respuestas.shift() ?? '' }
    },
  }
  const { tools } = await conCatalogoCargado(llm, (c) => { c.description.concurrency = 3 })
  const result = await tools.catalog_describe.execute({ limit: 4 }, ejecucion())

  assert.equal(result.written, 4)
  assert.equal(result.calls, 4, 'una llamada por ficha, ninguna de más')
  assert.equal(result.averageAttempts, 1)
  // El primero va solo; los otros tres a la vez.
  assert.equal(enVuelo.maxAllowed, 3, `concurrencia observada: ${enVuelo.maxAllowed}`)
})

test('dos fichas del mismo lote no pueden salir con el mismo handle', async () => {
  // Las tres primeras respuestas son idénticas: en paralelo, ninguna sabe de las
  // otras, así que la colisión hay que resolverla al aceptar.
  const iguales = [enBloques(VALIDO), enBloques(VALIDO), enBloques(VALIDO)]
  const distinta = enBloques(con({
    handle: 'ficha-distinta',
    seoDescription: `${VALIDO.seoDescription} Y esta es otra bien distinta de las demas.`,
    bodyHtml: VALIDO.bodyHtml.replace('barrica', 'barrica nueva'),
    feedDescription: `${VALIDO.feedDescription} Distinta.`,
  }))
  const { tools } = await conCatalogoCargado(
    llmSimulado([...iguales, distinta, distinta, distinta]).llm,
    (c) => { c.description.concurrency = 3 },
  )
  const result = await tools.catalog_describe.execute({ limit: 3 }, ejecucion())

  const handles = Object.values(JSON.parse(readFileSync(result.outputPath, 'utf8')).items)
    .map((f) => f.handle)
  assert.equal(new Set(handles).size, handles.length, `handles repetidos: ${handles.join(', ')}`)
  assert.ok(result.rejections.some((r) => r.code === 'handleDuplicado'), 'la colisión se cuenta')
})

test('el recuento de rechazos dice qué regla cuesta las llamadas', async () => {
  // Falla dos veces por el párrafo de entrada y acierta a la tercera.
  const largo = enBloques(con({
    bodyHtml: `<p>Un vino tinto ${'word '.repeat(45)}</p><ul><li>Uno</li><li>Dos</li><li>Tres</li></ul>`,
  }))
  const { tools } = await conCatalogoCargado(llmSimulado([largo, largo, enBloques(VALIDO)]).llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  assert.equal(result.written, 1)
  assert.equal(result.averageAttempts, 3)
  assert.equal(result.calls, 3)
  const entradaLarga = result.rejections.find((r) => r.code === 'entradaLarga')
  assert.equal(entradaLarga.count, 2, 'las dos veces que rechazó, contadas')
})

test('la tienda puede redactar con un modelo distinto al de la sesión', async () => {
  const simulado = llmSimulado([enBloques(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm, (c) => {
    c.description.provider = 'deepseek-official'
    c.description.model = 'deepseek-v4-pro'
  })
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion({ provider: 'otro', model: 'flash' }))
  assert.equal(simulado.calls[0].model, 'deepseek-v4-pro', 'manda la configuración, no la sesión')
})

test('la sonda del primer producto se salta si ya hay pruebas de que el modelo va', async () => {
  const distintas = ['a', 'b', 'c', 'd'].map((s) => enBloques(con({
    handle: `ficha-${s}`,
    seoDescription: `${VALIDO.seoDescription} Variante ${s} distinta de las demas del lote.`,
    bodyHtml: VALIDO.bodyHtml.replace('barrica', `barrica ${s}`),
    feedDescription: `${VALIDO.feedDescription} Variante ${s}.`,
  })))

  const enVuelo = { ahora: 0, maxAllowed: 0 }
  const llm = {
    async *stream() {
      enVuelo.ahora += 1
      enVuelo.maxAllowed = Math.max(enVuelo.maxAllowed, enVuelo.ahora)
      await new Promise((listo) => setTimeout(listo, 20))
      enVuelo.ahora -= 1
      yield { type: 'text-delta', index: 0, text: distintas.shift() ?? '' }
    },
  }
  const { tools, configPath } = await conCatalogoCargado(llm, (c) => { c.description.concurrency = 4 })

  // Primera carga: no hay nada escrito, así que sondea y el primero va solo.
  const primera = await tools.catalog_describe.execute({ limit: 2 }, ejecucion())
  assert.equal(primera.probed, true)
  assert.equal(enVuelo.maxAllowed, 1, 'el primero va solo')

  // Segunda: ya hay fichas de este modelo, así que los dos van a la vez.
  enVuelo.maxAllowed = 0
  const { catalog_describe: otra } = registrar(configPath, llm)
  const segunda = await otra.execute({ limit: 2, regenerate: 'always' }, ejecucion())
  assert.equal(segunda.probed, false, 'ya hay pruebas de que el modelo funciona')
  assert.ok(enVuelo.maxAllowed > 1, `deberían solaparse, y la concurrencia observada fue ${enVuelo.maxAllowed}`)
})

test('sin sonda, un fallo sistémico sigue cortando el lote', async () => {
  const { tools, configPath } = await conCatalogoCargado(
    llmSimulado([enBloques(VALIDO)]).llm,
    (c) => { c.description.probeFirst = 'never'; c.description.concurrency = 2 },
  )
  // Primero una ficha buena para que el almacén no esté vacío.
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  // Ahora el modelo deja de responder: el primer trozo falla entero.
  const { catalog_describe: mudo } = registrar(configPath, llmSimulado(Array(12).fill('')).llm)
  const result = await mudo.execute({ limit: 6 }, ejecucion())
  assert.equal(result.probed, false)
  assert.equal(result.written, 0)
  assert.ok(result.skipped > 0, 'el lote se corta aunque no haya sonda')
})

test('el resumen dice cuánto ha tardado y cuánto tarda una llamada', async () => {
  const llm = {
    async *stream() {
      await new Promise((listo) => setTimeout(listo, 60))
      yield { type: 'text-delta', index: 0, text: enBloques(VALIDO) }
    },
  }
  const { tools } = await conCatalogoCargado(llm)
  const result = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())
  assert.ok(result.secondsPerCall >= 0.05, `midió ${result.secondsPerCall}s`)
  assert.ok(result.seconds >= result.secondsPerCall)
})

test('el parámetro reasoningEffort pisa la configuración solo en esa llamada', async () => {
  const simulado = llmSimulado([enBloques(VALIDO), enBloques(VALIDO)])
  const { tools } = await conCatalogoCargado(simulado.llm, (c) => { c.description.reasoningEffort = 'low' })

  const conConfig = await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())
  assert.equal(simulado.calls[0].reasoningEffort, 'low')
  assert.equal(conConfig.effort, 'low')

  const pisado = await tools.catalog_describe.execute(
    { sku: '000101', regenerate: 'always', reasoningEffort: 'off' }, ejecucion(),
  )
  assert.equal(simulado.calls[1].reasoningEffort, 'off', 'manda el parámetro')
  assert.equal(pisado.effort, 'off', 'y el resumen lo dice, o el A/B no se puede comparar')
})

test('un esfuerzo que el proveedor no acepta se explica en vez de reventar', async () => {
  const llm = {
    // Lo que hace el adaptador de DeepSeek con un valor que no conoce.
    async *stream() {
      const error = new Error('DeepSeek does not support reasoning effort "medium"')
      error.code = 'UNSUPPORTED_REASONING_EFFORT'
      throw error
    },
  }
  const { tools } = await conCatalogoCargado(llm)
  await assert.rejects(
    () => tools.catalog_describe.execute({ sku: '000101', reasoningEffort: 'medium' }, ejecucion()),
    (error) => /no acepta el esfuerzo de razonamiento "medium"/.test(error.message)
      && /description\.reasoningEffort/.test(error.message)
      && /low solo desde rc\.8/.test(error.message),
  )
})

test('catalog_seo devuelve las fichas guardadas para poder leerlas', async () => {
  const simulado = llmSimulado([enBloques(VALIDO)])
  const { tools, configPath } = await conCatalogoCargado(simulado.llm)
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  const { catalog_seo: leer } = registrar(configPath)
  const todo = await leer.execute({})
  assert.equal(todo.total, 1)
  assert.equal(todo.unreviewed, 1)
  assert.equal(todo.drafts[0].seoTitle, VALIDO.seoTitle)

  const una = await leer.execute({ sku: '000101' })
  assert.equal(una.drafts.length, 1)

  const ninguna = await leer.execute({ sku: 'NO-EXISTE' })
  assert.deepEqual(ninguna.notFound, ['NO-EXISTE'])
  assert.equal(ninguna.drafts.length, 0)

  // Y el render las enseña de verdad: es lo que ve el usuario antes de aprobar.
  const text = leer.output.render({}, todo)[0].text
  assert.match(text, /SIN revisar/)
  assert.match(text, /bodyHtml/)
})

test('catalog_review es lo que convierte una ficha en publicable', async () => {
  const simulado = llmSimulado([enBloques(VALIDO)])
  const { tools, configPath } = await conCatalogoCargado(simulado.llm)
  await tools.catalog_describe.execute({ sku: '000101' }, ejecucion())

  const { catalog_review: revisar } = registrar(configPath)
  await assert.rejects(() => revisar.execute({}), /di qué revisar/)

  const result = await revisar.execute({ sku: '000101' })
  assert.equal(result.newlyReviewed, 1)
  assert.equal(result.unreviewed, 0)

  const otra = await revisar.execute({ sku: '000101' })
  assert.equal(otra.newlyReviewed, 0)
  assert.equal(otra.alreadyReviewed, 1)

  const inexistente = await revisar.execute({ sku: 'NO-EXISTE' })
  assert.deepEqual(inexistente.withoutDraft, ['NO-EXISTE'])
})
