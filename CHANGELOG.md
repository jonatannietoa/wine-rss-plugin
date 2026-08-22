# Changelog

Versión de la aplicación: `dsh-plugin/package.json`. Reglas de subida:
`.agent/rules/version-bump.md`.

- 1.1.1 — Arreglado: `catalog_describe` devolvía `sample[].warnings` sin declararlo en su
  esquema y el sandbox rechazaba la respuesta entera. Los tests validan ahora las cinco
  salidas contra su propio esquema, que es lo que no hacían.
- 1.1.0 — Migración a TypeScript (sin paso de compilación: Node hace type stripping) y
  reglas blandas: con el razonamiento apagado el modelo se pasa de los topes por 1-5
  caracteres, y ahora eso avisa en vez de tirar la ficha. `callsPerProduct` no esconde el
  trabajo perdido, y `regenerate: always` por lotes ya avanza en vez de repetirse.
- 1.0.0 — Código en inglés, prosa en castellano. **Rompe el contrato**: las claves de las
  salidas de las cinco tools se renombran (`intentosMedios` → `averageAttempts`, etc.).
  `ARCHITECTURE.md` documenta la arquitectura y una regla nueva obliga a mantenerlo.
- 0.7.3 — Arquitectura hexagonal por tool: un hexágono por cada una, `domain/product.js`
  como único dominio compartido, y `index.js` reducido a cableado (1183 → 567 líneas).
- 0.7.2 — `IN-PROGRESS-SEO.md`: estado de la etapa 3, el A/B abierto y las trampas encontradas.
- 0.7.1 — `reasoningEffort` por defecto a `off`: `high` cuesta 57,9 s por llamada de media
  frente a los 26,9 de `low`, y `off` es la medida que falta para cerrar la comparación.
- 0.7.0 — La primera frase puede nombrar la categoría, no solo el `productType`: los grupos
  genéricos del ERP (`Otros`, `Estuche`) forzaban una frase imposible y un reintento por
  producto. Y el resumen trae `razonamientoMaximo` para ver si `maxTokens` va al filo.
- 0.6.0 — `maxTokens` a 16000 (el razonamiento consume del mismo presupuesto y dejaba las
  respuestas vacías), `reasoningEffort` por defecto a `high` porque `low` no existe en todas las
  versiones del adaptador y esa versión no se puede fijar, parámetro `reasoningEffort` por llamada
  para medir, tool `catalog_seo` para leer las fichas antes de aprobarlas, y `dsh.sh` con `npx
  --yes` y comprobación de qué esfuerzos acepta el adaptador resuelto.
- 0.5.0 — Cronómetro del lote (`segundos`, `segundosPorLlamada`) y sonda del primer producto
  saltable con `description.probeFirst: auto`, que era un 33 % del tiempo de pared.
- 0.4.0 — Lote de descripciones en paralelo (`description.concurrency`), con el primero solo;
  recuento de qué regla rechaza borradores (`intentosMedios`, `rechazos`) y modelo propio
  para la etapa 3 vía `description.model`.
- 0.3.0 — Arreglado el presupuesto de la llamada al modelo (`reasoningEffort` y `maxTokens`
  desde la configuración), formato de bloques en vez de JSON, corte del lote ante un fallo
  sistémico, fallos diagnosticables y varias bandejas de entrada con `source.dirs`.
- 0.2.1 — Regla de subida de versión por tarea y changelog.
- 0.2.0 — Plugin renombrado a `catalog-agent`: ingesta y normalización de
  catálogo desde fichero, y textos SEO de Shopify con IA.
