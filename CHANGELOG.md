# Changelog

Versión de la aplicación: `dsh-plugin/package.json`. Reglas de subida:
`.agent/rules/version-bump.md`.

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
