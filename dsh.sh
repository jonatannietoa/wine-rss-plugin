#!/usr/bin/env bash
#
# Despliega la última versión del plugin en dsh y arranca el harness.
#
# Hace, en este orden y parándose en el primer fallo:
#   1. comprueba que la versión coincide en los tres sitios donde vive
#   2. instala las dependencias del plugin
#   3. pasa los tests
#   4. asegura que el perfil de dsh apunta a ESTE repo
#   5. despliega el preset a ~/.dsh/.agent-presets/
#   6. arranca el plugin fuera de dsh y prueba las herramientas en seco
#   7. para lo que hubiera escuchando en el puerto
#   8. arranca dsh en primer plano
#
# Uso:
#   ./dsh.sh                    despliega y arranca
#   ./dsh.sh -n                 solo despliega, no arranca
#   ./dsh.sh --port 8080        otro puerto
#   SKIP_TESTS=1 ./dsh.sh       salta los tests (para iterar rápido)
#   SKIP_VERSION_CHECK=1 ./dsh.sh
#
# Al terminar hay que abrir SESIÓN NUEVA en el navegador: una sesión ya abierta
# se queda con el código y el preset que tenía cuando se creó.

set -euo pipefail

readonly REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PLUGIN="$REPO/dsh-plugin"
readonly PRESET_SRC="$REPO/agent-presets/catalog-agent"
readonly PRESET_DST="$HOME/.dsh/.agent-presets/catalog-agent"
readonly DSH="@deepseek-ai/dsh@0.1.0-rc.6"
readonly PERFIL="web"

PUERTO=3080
ARRANCAR=1
EXTRA=()

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--no-start) ARRANCAR=0; shift ;;
    --port) PUERTO="$2"; EXTRA+=(--port "$2"); shift 2 ;;
    -h|--help) sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

paso() { printf '\n\033[1m── %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
aviso(){ printf '   \033[33m!\033[0m %s\n' "$*"; }
morir(){ printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. la versión vive en tres sitios y tienen que coincidir ────────────────
paso "Versión"
VERSION="$(node -p "require('$PLUGIN/package.json').version")"
V_PRESET="$(sed -n 's/^name:.*(\(.*\)).*/\1/p' "$PRESET_SRC/preset.yml")"
# Semver estricto: la frase de la persona acaba en punto y se colaría en la versión.
V_PERSONA="$(grep -oE 'dsh-plugin-catalog-agent\): [0-9]+\.[0-9]+\.[0-9]+' "$PRESET_SRC/agent.cordis.yml" | sed 's/.*: //')"
printf '   package.json %s · preset.yml %s · persona %s\n' "$VERSION" "${V_PRESET:-—}" "${V_PERSONA:-—}"
if [ "${SKIP_VERSION_CHECK:-0}" != 1 ] && { [ "$VERSION" != "$V_PRESET" ] || [ "$VERSION" != "$V_PERSONA" ]; }; then
  morir "la versión no coincide en los tres sitios. dsh lee el preset, así que enseñaría la vieja.
  Cuadra 'name:' de preset.yml y la línea de la persona de agent.cordis.yml con $VERSION,
  o salta esta comprobación con SKIP_VERSION_CHECK=1."
fi
ok "coincide en los tres sitios"

# ── 2. dependencias del plugin ──────────────────────────────────────────────
paso "Dependencias"
(cd "$PLUGIN" && npm install --silent)
ok "$(node -p "Object.keys(require('$PLUGIN/package.json').dependencies).length") dependencias al día"

# ── 3. tests ────────────────────────────────────────────────────────────────
paso "Tests"
if [ "${SKIP_TESTS:-0}" = 1 ]; then
  aviso "saltados (SKIP_TESTS=1)"
else
  if ! SALIDA="$(cd "$PLUGIN" && npm test 2>&1)"; then
    printf '%s\n' "$SALIDA" | tail -30
    morir "los tests fallan: no despliego esto"
  fi
  ok "$(printf '%s' "$SALIDA" | sed -n 's/^. pass \([0-9]*\)/\1/p') tests en verde"
fi

# ── 4. el perfil de dsh tiene que apuntar a este repo ───────────────────────
paso "Plugin en el perfil '$PERFIL'"
ENLACE="$HOME/.dsh/profiles/$PERFIL/node_modules/dsh-plugin-catalog-agent"
DESTINO=""
[ -e "$ENLACE" ] && DESTINO="$(cd "$(dirname "$ENLACE")" && cd "$(readlink "$ENLACE" 2>/dev/null || echo .)" && pwd)"
if [ "$DESTINO" = "$PLUGIN" ]; then
  ok "ya enlazado (no hace falta reinstalar: es un symlink al repo)"
else
  aviso "sin enlazar o apuntando a otro sitio; lo instalo"
  (cd "$REPO" && npx --yes "$DSH" plugin --profile "$PERFIL" add "$PLUGIN")
  ok "instalado"
fi

# ── 5. preset ───────────────────────────────────────────────────────────────
paso "Preset"
mkdir -p "$PRESET_DST"
if diff -rq "$PRESET_SRC" "$PRESET_DST" >/dev/null 2>&1; then
  ok "ya estaba al día"
else
  cp "$PRESET_SRC"/*.yml "$PRESET_DST/"
  ok "copiado a $PRESET_DST"
fi

# ── 6. el plugin arranca y sus herramientas responden ───────────────────────
paso "Prueba en seco"
SMOKE="$(mktemp -t catalog-smoke)".mjs
cat > "$SMOKE" <<'NODE'
const { apply, Config, name } = await import(process.env.ENTRADA)
const tools = {}
apply({ tools: { register: (t) => { tools[t.name] = t } }, llm: {} }, Config({ configPath: process.env.CONFIG }))
console.log(`   plugin "${name}" con ${Object.keys(tools).length} herramientas: ${Object.keys(tools).join(', ')}`)

const carga = await tools.catalog_load.execute({})
console.log(`   catalog_load: ${carga.ok} productos de ${carga.total} filas, ${carga.rechazados} rechazadas`)

const seco = await tools.catalog_describe.execute({ limit: 1, dryRun: true }, {
  agent: { options: {} },
  signal: AbortSignal.timeout(20000),
})
if (!seco.prompt) throw new Error('dryRun tenía que devolver el prompt y no lo ha hecho')
console.log(`   catalog_describe dryRun: prompt de ${seco.prompt.system.length}+${seco.prompt.user.length} caracteres`)
console.log(`   pendientes de ficha SEO: ${seco.pendientes}`)
NODE
ENTRADA="$ENLACE/lib/index.js" CONFIG="$REPO/catalog.config.yml" node "$SMOKE" || {
  rm -f "$SMOKE"; morir "el plugin no arranca desde el perfil de dsh"
}
rm -f "$SMOKE"
ok "las herramientas responden cargadas desde el perfil"

# ── 6b. qué esfuerzos de razonamiento acepta el adaptador resuelto ──────────
# La versión del adaptador NO se puede fijar: `dsh` declara sus dependencias con
# rangos, así que npm resuelve `dsh-llm-deepseek` a lo más nuevo que encaje. En
# dos cachés de npx de esta máquina salieron rc.6 y rc.8, y aceptan esfuerzos
# distintos. Si la configuración pide uno que el adaptador no conoce, la carga de
# descripciones revienta en mitad del lote: mejor saberlo aquí.
paso "Esfuerzo de razonamiento"
ADAPTADOR="$(ls -dt "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh-llm-deepseek 2>/dev/null | head -1)"
if [ -n "$ADAPTADOR" ]; then
  V_ADAPTADOR="$(node -p "require('$ADAPTADOR/package.json').version" 2>/dev/null || echo '?')"
  ACEPTA="$(grep -oE 'effort === "[a-z]+"' "$ADAPTADOR/lib/index.js" 2>/dev/null | sed 's/.*"\(.*\)"/\1/' | sort -u | tr '\n' ' ')"
  PEDIDO="$(sed -n 's/^  reasoningEffort: *\([a-z]*\).*/\1/p' "$REPO/catalog.config.yml" | head -1)"
  printf '   adaptador %s acepta: %s\n' "$V_ADAPTADOR" "${ACEPTA:-(no se pudo leer)}"
  if [ -n "$PEDIDO" ] && [ -n "$ACEPTA" ] && ! printf '%s' "$ACEPTA" | grep -qw "$PEDIDO"; then
    morir "la configuración pide reasoningEffort \"$PEDIDO\" y este adaptador no lo acepta.
  Cambia \`description.reasoningEffort\` en catalog.config.yml a uno de: $ACEPTA"
  fi
  ok "la configuración pide \"${PEDIDO:-?}\", y lo acepta"
else
  aviso "no se encontró el adaptador de DeepSeek en la caché de npx; se comprobará al usarlo"
fi

# ── 7. parar lo que hubiera ─────────────────────────────────────────────────
# Solo si vamos a arrancar: con -n el usuario espera seguir con el dsh que tenía.
if [ "$ARRANCAR" = 0 ]; then
  paso "Listo"
  if lsof -tnP -iTCP:"$PUERTO" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '   Desplegado, sin arrancar (-n). El dsh que corre en %s sigue vivo con el\n' "$PUERTO"
    printf '   código anterior: reinícialo con ./dsh.sh para que coja este.\n'
  else
    printf '   Desplegado, sin arrancar (-n). Para arrancar: ./dsh.sh\n'
  fi
  exit 0
fi

paso "Puerto $PUERTO"
VIEJO="$(lsof -tnP -iTCP:"$PUERTO" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
if [ -n "$VIEJO" ]; then
  aviso "paro el dsh que había (pid $VIEJO)"
  kill "$VIEJO" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -tnP -iTCP:"$PUERTO" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 0.5
  done
  lsof -tnP -iTCP:"$PUERTO" -sTCP:LISTEN >/dev/null 2>&1 && morir "el puerto $PUERTO sigue ocupado"
  ok "libre"
else
  ok "libre"
fi

# ── 8. arrancar ─────────────────────────────────────────────────────────────
paso "Arrancando dsh $VERSION en http://localhost:$PUERTO"
printf '   Se para con Ctrl-C. Abre SESIÓN NUEVA: una ya abierta se queda con el código viejo.\n\n'
# El directorio de lanzamiento es la raíz de workspace de la sesión.
cd "$REPO"
# `${EXTRA[@]+...}`: en el bash 3.2 de macOS, expandir un array vacío bajo
# `set -u` es un error de variable sin definir.
exec npx --yes "$DSH" web ${EXTRA[@]+"${EXTRA[@]}"}
