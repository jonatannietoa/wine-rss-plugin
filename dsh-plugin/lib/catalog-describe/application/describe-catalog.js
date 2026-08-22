/**
 * Aplicación de la etapa 3: orquesta catálogo → prompt → modelo → validación.
 *
 * Aquí vive lo que no es ni dominio ni infraestructura: construir el prompt
 * combinando las reglas del cliente con el producto, el bucle de reintentos, el
 * reparto del lote en paralelo y la política de qué se rehace.
 *
 * El bucle de reintentos está aquí y no en el agente a propósito: son cientos de
 * productos, y meter cada corrección en la conversación llenaría el contexto.
 *
 * @module dsh-plugin-catalog-agent/catalog-describe/application/describe-catalog
 */

import { FIELD_ROLES, SEO_FIELDS, keywords, legible, validateDraft } from '../domain/seo-draft.js'
import { parseBlocks, pedirFicha } from '../infra/llm-adapter.js'
import { cargarCatalogo } from '../infra/catalog-reader.js'
import { cargarSeo, guardarSeo, rutaSeo } from '../infra/seo-store.js'

/** Los datos del producto que el modelo puede ver, y ninguno más. */
function datosVisibles(product, config) {
  const campos = config.description?.fields ?? ['title', 'productType']
  const datos = {}
  for (const campo of campos) {
    const valor = legible(product, campo, config)
    if (valor !== null) datos[campo] = valor
  }
  return datos
}

/**
 * Construye el prompt de un producto.
 *
 * Las cifras salen de la configuración, no del texto: cambiar un límite en
 * `catalog.config.yml` cambia lo que se le pide al modelo y lo que se le valida
 * después, que es la única forma de que no se contradigan.
 * @param product - el producto normalizado.
 * @param config - la configuración cargada.
 * @param problemas - lo que hay que corregir de un intento anterior.
 * @returns `{ system, user }`, los dos textos de la llamada.
 */
export function buildPrompt(product, config, problemas = []) {
  const d = config.description ?? {}
  const bullets = d.bodyHtml?.bullets ?? { min: 3, max: 5, maxChars: 90 }
  const claves = keywords(product, config)

  const system = [
    `Escribes fichas de producto para una tienda online, en ${d.language ?? 'es'}.`,
    d.tone ? `Tono: ${d.tone}` : '',
    d.audience ? `Le hablas a: ${d.audience}` : '',
    '',
    'Cómo se escribe una ficha que rinde en buscador:',
    '- Escribe para quien compra, no para el buscador. Di qué es el producto, para quién y cómo se usa.',
    '- Primero el beneficio y luego el dato que lo sostiene. El dato solo no vende: explica qué le hace al comprador.',
    '- La primera frase dice qué es el producto. Sin rodeos ni frases de apertura vacías.',
    '- Usa las keywords donde importan (título, primera frase, metadatos) y solo si describen el producto de verdad.',
    `- Nunca repitas la misma keyword más de ${d.maxKeywordRepeats ?? 3} veces: eso es keyword stuffing y penaliza.`,
    '- Cada ficha es distinta de las demás. Nada de plantillas ni de texto reciclado entre productos.',
    '- El texto alternativo describe lo que se ve en la foto, en lenguaje llano. No es un sitio para keywords.',
    '- La descripción del feed describe el mismo producto que la ficha, sin lenguaje promocional.',
    '',
    'Lo que NO puedes hacer:',
    ...(d.forbid ?? []).map((regla) => `- No menciones ${regla}.`),
    '- No inventes ningún dato que no esté en los datos del producto que te doy.',
    '- No uses lenguaje promocional (envío gratis, mejor precio, oferta limitada): eso va en otros campos de Shopify.',
    '',
    'Responde con seis bloques, cada uno abierto por su cabecera en una línea propia y nada más.',
    'Sin markdown alrededor, sin explicaciones, sin repetir estas instrucciones. Así exactamente:',
    '',
    `### seoTitle`,
    `${FIELD_ROLES.seoTitle}. Máximo ${d.seoTitle?.maxChars ?? 60} caracteres.`,
    '',
    `### seoDescription`,
    `${FIELD_ROLES.seoDescription}. Entre ${d.seoDescription?.minChars ?? 70} y ${d.seoDescription?.maxChars ?? 155} caracteres.`,
    '',
    `### bodyHtml`,
    `${FIELD_ROLES.bodyHtml}. Máximo ${d.bodyHtml?.maxChars ?? 700} caracteres.`
      + ` Exactamente un <p> de entrada de como mucho ${d.bodyHtml?.leadMaxWords ?? 40} palabras,`
      + ` y después un <ul> con entre ${bullets.min} y ${bullets.max} <li> de como mucho ${bullets.maxChars} caracteres cada uno.`
      + ` Solo estas etiquetas: ${(d.bodyHtml?.allowTags ?? ['p', 'ul', 'li']).join(', ')}.`
      + ' El HTML va tal cual, sin comillas alrededor y sin escapar nada.',
    '',
    `### handle`,
    `${FIELD_ROLES.handle}. Minúsculas, sin acentos, palabras separadas por guiones, máximo ${d.handle?.maxChars ?? 70} caracteres.`,
    '',
    `### altText`,
    `${FIELD_ROLES.altText}. Máximo ${d.altText?.maxChars ?? 125} caracteres.`,
    '',
    `### feedDescription`,
    `${FIELD_ROLES.feedDescription}. Máximo ${d.feedDescription?.maxChars ?? 500} caracteres.`,
    '',
    'Escribe los seis, en ese orden, y termina cada uno antes de abrir el siguiente.',
  ].filter(Boolean).join('\n')

  const partes = [
    'Datos del producto (es TODO lo que se sabe de él):',
    JSON.stringify(datosVisibles(product, config), null, 2),
  ]
  if (claves.length > 0) {
    partes.push(
      '',
      `Keywords que describen este producto: ${claves.join(', ')}.`,
      'Úsalas donde encajen de forma natural. Si alguna no encaja en una frase, no la metas.',
    )
  }
  if (problemas.length > 0) {
    partes.push(
      '',
      'Tu respuesta anterior no vale. Corrige exactamente esto y devuelve el JSON completo otra vez:',
      ...problemas.map((problema) => `- ${problema}`),
    )
  }

  return { system, user: partes.join('\n') }
}

/**
 * Los handles y los textos que ya están en uso, para que dos fichas no salgan
 * iguales ni compartan URL.
 * @param items - las fichas ya generadas.
 * @param excluir - SKUs que se están regenerando y por tanto no cuentan.
 * @returns `{ handles, textos }`.
 */
function yaUsados(items, excluir = new Set()) {
  const handles = new Set()
  const textos = new Set()
  for (const [sku, ficha] of Object.entries(items)) {
    if (excluir.has(sku)) continue
    if (ficha.handle) handles.add(ficha.handle)
    for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
      if (ficha[campo]) textos.add(`${campo}:${ficha[campo]}`)
    }
  }
  return { handles, textos }
}

/**
 * Pide al modelo de la sesión los textos de un producto y no se da por
 * satisfecho hasta que pasan la validación.
 *
 * El bucle de reintentos está aquí y no en el agente a propósito: son cientos de
 * productos, y meter cada corrección en la conversación llenaría el contexto.
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param modelo - `{ provider, model }` de la sesión.
 * @param product - el producto normalizado.
 * @param dominio - la configuración cargada.
 * @param usados - handles y textos ya en uso.
 * @param signal - la señal de cancelación del tool.
 * @param problemasIniciales - lo que hay que corregir de entrada, cuando se
 *   reintenta por haber chocado con otra ficha del mismo lote.
 * @param esfuerzo - esfuerzo de razonamiento que pisa el de la configuración,
 *   para poder medir un valor contra otro sin editar ficheros.
 * @param plugin - el nombre del plugin, para el origen del mensaje.
 * @returns `{ draft }` si pasó, o `{ problemas }` con lo que falló en el último
 *   intento; y en los dos casos `rechazos`, los códigos de lo que se rechazó.
 */
async function redactar(ctx, modelo, product, dominio, usados, signal, problemasIniciales = [], esfuerzo = undefined, plugin = 'catalog-agent') {
  const d = dominio.description ?? {}
  const maxIntentos = d.maxAttempts ?? 3
  let problemas = problemasIniciales
  let diagnostico = null
  // Los códigos de todo lo que se rechazó por el camino, aunque al final salga
  // bien: es lo único que dice qué regla está costando llamadas.
  const rechazos = []
  const milisegundos = []
  // El pico de razonamiento del lote: es lo que dice si `maxTokens` va holgado o
  // al filo, y hasta ahora solo se veía en los fallos definitivos.
  let razonamientoMaximo = 0
  // Si ni un intento produjo un bloque aprovechable, el fallo no es de este
  // producto: es del modelo o del prompt, y seguir con el lote es tirar llamadas.
  let algunBloque = false

  for (let intento = 1; intento <= maxIntentos; intento += 1) {
    const { system, user } = buildPrompt(product, dominio, problemas.map((x) => x.message))
    const { texto, razonamiento, milisegundos: tardo, cruda } = await pedirFicha(ctx, {
      modelo,
      system,
      user,
      reasoningEffort: esfuerzo ?? d.reasoningEffort ?? 'high',
      // Holgado a propósito: el razonamiento consume de este mismo presupuesto,
      // y un tope justo para el texto deja la respuesta vacía.
      maxTokens: d.maxTokens ?? 16000,
      temperature: d.temperature,
      plugin,
      signal,
    })
    milisegundos.push(tardo)
    razonamientoMaximo = Math.max(razonamientoMaximo, razonamiento)
    diagnostico = {
      caracteresTexto: texto.length,
      caracteresRazonamiento: razonamiento,
      respuestaCruda: cruda,
    }

    let draft
    try {
      draft = parseBlocks(texto)
    } catch (error) {
      problemas = [{ code: 'sinBloques', message: error.message }]
      // El síntoma que costó ocho borradores en blanco: todo el presupuesto en
      // razonamiento y nada escrito. Decirlo con nombre ahorra el diagnóstico.
      if (texto.length === 0 && razonamiento > 0) {
        problemas.push({
          code: 'sinTexto',
          message: `el modelo gastó ${razonamiento} caracteres razonando y no escribió nada: `
            + 'sube `description.maxTokens` o baja `description.reasoningEffort`',
        })
      } else {
        problemas.push({ code: 'ayuda', message: 'Empieza directamente por "### seoTitle", sin texto alrededor.' })
      }
      rechazos.push(...problemas.map((x) => x.code))
      continue
    }
    algunBloque = true

    problemas = validateDraft(draft, product, dominio, usados)
    rechazos.push(...problemas.map((x) => x.code))
    if (problemas.length === 0) {
      return {
        draft: {
          sku: product.sku,
          ...Object.fromEntries(SEO_FIELDS.map((campo) => [campo, draft[campo]])),
          reviewed: false,
          generatedAt: new Date().toISOString(),
          model: `${modelo.provider}/${modelo.model}`,
          attempts: intento,
        },
        rechazos,
        milisegundos,
        razonamientoMaximo,
      }
    }
  }

  return { problemas, diagnostico, rechazos, milisegundos, razonamientoMaximo, sistemico: !algunBloque }
}

/**
 * Reserva el handle y los textos de una ficha para que ninguna otra los repita.
 * @param draft - la ficha aceptada.
 * @param usados - los conjuntos compartidos.
 */
function reservar(draft, usados) {
  usados.handles.add(draft.handle)
  for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
    usados.textos.add(`${campo}:${draft[campo]}`)
  }
}

/**
 * Si una ficha choca con otra aceptada mientras se generaba en paralelo.
 *
 * Los productos de un lote se redactan a la vez contra la misma foto de lo ya
 * usado, así que dos pueden elegir el mismo handle sin que ninguno lo sepa. Esto
 * se comprueba al aceptar, que es cuando ya hay un orden.
 * @param draft - la ficha a aceptar.
 * @param usados - los conjuntos, ya con las fichas aceptadas antes que esta.
 * @returns los problemas de unicidad, o lista vacía.
 */
function choca(draft, usados) {
  const problemas = []
  if (usados.handles.has(draft.handle)) {
    problemas.push({
      code: 'handleDuplicado',
      message: `handle "${draft.handle}" ya lo tiene otro producto de este mismo lote, y la URL tiene que ser única`,
    })
  }
  for (const campo of ['seoDescription', 'bodyHtml', 'feedDescription']) {
    if (usados.textos.has(`${campo}:${draft[campo]}`)) {
      problemas.push({
        code: 'textoDuplicado',
        message: `${campo} es idéntico al de otro producto de este mismo lote; cada ficha tiene que ser distinta`,
      })
    }
  }
  return problemas
}

/**
 * Escribe las fichas SEO de un lote de productos.
 * @param ctx - el contexto Cordis, por su servicio `llm`.
 * @param dominio - la configuración cargada.
 * @param args - lo que pidió quien llama.
 * @param exec - la ejecución del tool: el modelo de la sesión y su señal.
 * @param plugin - el nombre del plugin, para el origen de los mensajes.
 * @returns el resumen del lote.
 */
export async function describeCatalog(ctx, dominio, args, exec, plugin) {
  // El catálogo sale del JSON que dejó `catalog_load`, no de releer el fichero
  // configurado: si el usuario cargó otro, es ese el que hay que describir.
  const catalog = cargarCatalogo(dominio)
  const porSku = new Map(catalog.items.map((item) => [item.sku, item]))
  const salida = rutaSeo(dominio)
  const fichas = cargarSeo(salida)

  const politica = args.regenerate ?? dominio.description?.regenerate ?? 'missing'
  if (politica === 'never') {
    throw new Error('la configuración dice `description.regenerate: never`: no se escribe ninguna ficha')
  }
  const pendientes = catalog.items.filter((item) => politica === 'always' || !fichas[item.sku])

  let objetivo
  const pedidos = [...(args.sku ? [args.sku.trim()] : []), ...(args.skus ?? []).map((s) => String(s).trim())]
  if (pedidos.length > 0) {
    const desconocidos = pedidos.filter((sku) => !porSku.has(sku))
    if (desconocidos.length > 0) {
      throw new Error(`estos SKU no están en el catálogo: ${desconocidos.join(', ')}`)
    }
    objetivo = pedidos.map((sku) => porSku.get(sku))
  } else if (args.limit) {
    if (args.limit < 1) throw new Error(`limit tiene que ser 1 o más (recibido ${args.limit})`)
    objetivo = pendientes.slice(0, args.limit)
  } else {
    throw new Error(
      `hay ${pendientes.length} productos sin ficha de ${catalog.items.length} del catálogo, y cada uno es `
      + 'una llamada al modelo. Acota el lote: `limit` para procesar los N primeros pendientes, o `sku`/`skus` '
      + 'para productos concretos.',
    )
  }

  const techo = dominio.description?.maxPerCall ?? 50
  if (objetivo.length > techo) {
    throw new Error(
      `has pedido ${objetivo.length} productos y el techo por llamada es ${techo} `
      + '(`description.maxPerCall`). Ve por lotes.',
    )
  }
  if (objetivo.length === 0) {
    throw new Error('no hay ningún producto pendiente: todos tienen ficha ya. Usa `regenerate: always` para rescribir.')
  }

  const usados = yaUsados(fichas, new Set(objetivo.map((item) => item.sku)))

  if (args.dryRun) {
    return {
      outputPath: salida,
      sourcePath: catalog.source?.path ?? '(desconocido)',
      modelo: '(prueba en seco: no se ha llamado a ninguno)',
      solicitados: objetivo.length,
      generados: 0,
      fallidos: 0,
      cortado: 0,
      llamadas: 0,
      segundos: 0,
      razonamientoMaximo: 0,
      segundosPorLlamada: 0,
      esfuerzo: args.reasoningEffort?.trim() || dominio.description?.reasoningEffort || 'high',
      maxTokensConfigurado: dominio.description?.maxTokens ?? 16000,
      sonda: false,
      intentosMedios: 0,
      rechazos: [],
      pendientes: pendientes.length,
      sinRevisar: Object.values(fichas).filter((f) => !f.reviewed).length,
      fallos: [],
      muestra: [],
      prompt: buildPrompt(objetivo[0], dominio),
    }
  }

  // Por defecto redacta con el modelo de la sesión, pero la tienda puede
  // fijar otro: charlar con uno rápido y escribir las fichas con uno que
  // siga mejor las restricciones de formato es una combinación razonable.
  const opciones = exec.agent?.options
  const modelo = {
    provider: dominio.description?.provider ?? opciones?.provider,
    model: dominio.description?.model ?? opciones?.model,
  }
  if (!modelo.provider || !modelo.model) {
    throw new Error(
      'no se ha podido averiguar el modelo de esta sesión, así que no hay con qué redactar. '
      + 'Fija `description.provider` y `description.model` en la configuración, o revisa el host.',
    )
  }

  const generadas = []
  const fallos = []
  const rechazos = []
  let cortado = 0
  let llamadas = 0

  const tiempos = []
  let picoRazonamiento = 0

  /** Acepta o registra el resultado de un producto. */
  const asentar = (product, resultado) => {
    rechazos.push(...(resultado.rechazos ?? []))
    tiempos.push(...(resultado.milisegundos ?? []))
    picoRazonamiento = Math.max(picoRazonamiento, resultado.razonamientoMaximo ?? 0)
    llamadas += resultado.draft?.attempts ?? (dominio.description?.maxAttempts ?? 3)
    if (resultado.draft) {
      fichas[product.sku] = resultado.draft
      generadas.push(resultado.draft)
      reservar(resultado.draft, usados)
      return
    }
    fallos.push({
      sku: product.sku,
      problemas: resultado.problemas.map((x) => x.message),
      caracteresTexto: resultado.diagnostico?.caracteresTexto ?? 0,
      caracteresRazonamiento: resultado.diagnostico?.caracteresRazonamiento ?? 0,
      respuestaCruda: resultado.diagnostico?.respuestaCruda ?? '',
    })
  }

  const arranqueLote = Date.now()
  const concurrencia = Math.max(1, dominio.description?.concurrency ?? 4)

  // La sonda: el primer producto solo, para que un modelo mal configurado
  // cueste tres llamadas y no un lote entero. Pero es una ola secuencial
  // completa —un 33 % del tiempo de pared en un lote de cuatro—, así que con
  // `auto` se salta cuando ya hay una ficha escrita por ESTE mismo modelo:
  // eso es prueba de que la configuración funciona.
  const politicaSonda = dominio.description?.probeFirst ?? 'auto'
  const yaFuncionó = Object.values(fichas).some(
    (ficha) => ficha.model === `${modelo.provider}/${modelo.model}`,
  )
  const sondear = politicaSonda === 'always'
    || (politicaSonda !== 'never' && !yaFuncionó)

  const esfuerzo = args.reasoningEffort?.trim() || undefined

  let resto = objetivo
  if (sondear) {
    const [cabeza, ...cola] = objetivo
    resto = cola
    exec.signal.throwIfAborted()
    const primero = await redactar(ctx, modelo, cabeza, dominio, usados, exec.signal, [], esfuerzo, plugin)
    asentar(cabeza, primero)
    if (primero.sistemico) resto = []
    cortado = primero.sistemico ? cola.length : 0
  }

  if (cortado === 0) {
    for (let inicio = 0; inicio < resto.length; inicio += concurrencia) {
      exec.signal.throwIfAborted()
      const trozo = resto.slice(inicio, inicio + concurrencia)
      const resultados = await Promise.all(
        trozo.map((product) => redactar(ctx, modelo, product, dominio, usados, exec.signal, [], esfuerzo, plugin)),
      )
      // Se aceptan en orden, no a la vez: el trozo se redactó contra la
      // misma foto de lo ya usado, así que dos fichas pueden haber elegido
      // el mismo handle sin saberlo. Quien llega segundo lo repite.
      for (const [indice, resultado] of resultados.entries()) {
        const product = trozo[indice]
        const colisiones = resultado.draft ? choca(resultado.draft, usados) : []
        if (colisiones.length === 0) {
          asentar(product, resultado)
          continue
        }
        const reintento = await redactar(
          ctx, modelo, product, dominio, usados, exec.signal, colisiones, esfuerzo, plugin,
        )
        asentar(product, {
          ...reintento,
          rechazos: [...(resultado.rechazos ?? []), ...colisiones.map((x) => x.code)],
          milisegundos: [...(resultado.milisegundos ?? []), ...(reintento.milisegundos ?? [])],
        })
      }

      // Sin sonda, la guarda pasa al primer trozo: si nadie de ahí produjo un
      // bloque, el fallo es de configuración y no hay que seguir.
      if (!sondear && inicio === 0 && generadas.length === 0
          && resultados.every((r) => r.sistemico)) {
        cortado = resto.length - trozo.length
        break
      }
    }
  }
  guardarSeo(salida, fichas)

  const segundos = Math.round((Date.now() - arranqueLote) / 100) / 10
  const segundosPorLlamada = tiempos.length === 0
    ? 0
    : Math.round((tiempos.reduce((a, b) => a + b, 0) / tiempos.length) / 100) / 10

  const cuenta = new Map()
  for (const code of rechazos) cuenta.set(code, (cuenta.get(code) ?? 0) + 1)

  return {
    outputPath: salida,
    sourcePath: catalog.source?.path ?? '(desconocido)',
    modelo: `${modelo.provider}/${modelo.model}`,
    solicitados: objetivo.length,
    generados: generadas.length,
    fallidos: fallos.length,
    cortado,
    llamadas,
    segundos,
    razonamientoMaximo: picoRazonamiento,
    segundosPorLlamada,
    esfuerzo: esfuerzo ?? dominio.description?.reasoningEffort ?? 'high',
    maxTokensConfigurado: dominio.description?.maxTokens ?? 16000,
    sonda: sondear,
    intentosMedios: generadas.length === 0
      ? 0
      : Math.round((generadas.reduce((suma, f) => suma + f.attempts, 0) / generadas.length) * 100) / 100,
    rechazos: [...cuenta]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ code, count })),
    pendientes: catalog.items.filter((item) => !fichas[item.sku]).length,
    sinRevisar: Object.values(fichas).filter((ficha) => !ficha.reviewed).length,
    fallos: fallos.slice(0, 5),
    muestra: generadas.slice(0, 1),
    prompt: null,
  }
}
