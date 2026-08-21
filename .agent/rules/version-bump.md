# Subida de versión por tarea

## Fuente única

La versión de la aplicación vive **solo** en `dsh-plugin/package.json`, campo
`version`, en formato semver `x.y.z`. Cualquier otro sitio donde aparezca el
número es un espejo y se deriva de ahí.

`catalog.config.yml` tiene su propio `version: 1`: es la versión del **esquema de
configuración**, no la de la aplicación. Esta regla no lo toca.

## Cuándo se sube

- Toda tarea que deje cambios en el árbol de trabajo (código, config, presets,
  tests, documentación) termina con **una** subida de versión, aunque haya
  tocado varios ficheros.
- No se sube versión cuando la tarea no cambia el árbol (preguntas, lectura,
  exploración), ni cuando lo único que cambia son datos o secretos:
  `catalogo*.csv`, `stock-*.csv`, `entradas/`, `.env`, `.artifacts/`.
- Nunca dos subidas en la misma tarea. Si la versión ya se subió en esta tarea,
  se corrige la que hay en lugar de encadenar otra.

## Qué dígito

- **major (`x`)**: rompe un contrato. Cambia el formato de `catalog.config.yml`,
  el nombre o la firma de un tool, o la forma de una salida que consume otro.
- **minor (`y`)**: capacidad nueva sin romper nada. Una etapa o tool nuevo, un
  bloque de configuración nuevo, un campo nuevo en la salida.
- **patch (`z`)**: corrección de bug, ajuste de prompt o de tono, documentación,
  tests, refactor sin cambio de contrato.

Ante la duda entre minor y patch, patch. Ante la duda entre major y minor,
preguntar antes de subir.

## Cómo se sube

```bash
cd dsh-plugin && npm version <patch|minor|major> --no-git-tag-version
```

`--no-git-tag-version` es obligatorio: actualiza `package.json` y
`package-lock.json` a la vez y no crea commit ni tag. Editar el número a mano
en un solo fichero deja el lock desincronizado.

## Espejos a sincronizar en la misma tarea

Con la versión nueva `x.y.z`:

- `agent-presets/catalog-agent/preset.yml`, línea `name:` →
  `Agente de catálogo (x.y.z)`
- `agent-presets/catalog-agent/agent.cordis.yml` →
  `Versión del código (dsh-plugin-catalog-agent): x.y.z.`
- `CHANGELOG.md` → línea nueva al principio de la lista:
  `- x.y.z — <qué cambió, una frase>`

Verificación (debe dar 6 líneas: 1 de `package.json`, 2 del lock, 1 del preset,
1 del `agent.cordis.yml`, 1 del changelog):

```bash
grep -rn "x.y.z" dsh-plugin/package.json dsh-plugin/package-lock.json \
  agent-presets CHANGELOG.md | wc -l
```

## Límite

Subir la versión no autoriza a commitear: sigue vigente `no-auto-commit.md`.
Los cambios, incluida la subida, se quedan en el árbol de trabajo.
