# Changelog

Versión de la aplicación: `dsh-plugin/package.json`. Reglas de subida:
`.agent/rules/version-bump.md`.

- 0.4.0 — Lote de descripciones en paralelo (`description.concurrency`), con el primero solo;
  recuento de qué regla rechaza borradores (`intentosMedios`, `rechazos`) y modelo propio
  para la etapa 3 vía `description.model`.
- 0.3.0 — Arreglado el presupuesto de la llamada al modelo (`reasoningEffort` y `maxTokens`
  desde la configuración), formato de bloques en vez de JSON, corte del lote ante un fallo
  sistémico, fallos diagnosticables y varias bandejas de entrada con `source.dirs`.
- 0.2.1 — Regla de subida de versión por tarea y changelog.
- 0.2.0 — Plugin renombrado a `catalog-agent`: ingesta y normalización de
  catálogo desde fichero, y textos SEO de Shopify con IA.
