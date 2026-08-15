"""
Suite de evaluación con deepeval para el agente de vinos.

Requiere una clave para el modelo "juez" de deepeval (por defecto usa OpenAI,
ver https://docs.confident-ai.com para configurar el proveedor). Ejecutar con:

    export OPENAI_API_KEY=sk-...       # el juez de deepeval (GEval)
    export DEEPSEEK_API_KEY=sk-...     # opcional: si no está, el agente corre en modo mock
    deepeval test run eval/test_wine_agent.py

Casos incluidos:
  1. test_case_pass                -> el agente responde bien, la métrica pasa.
  2. test_case_fail                -> respuesta con recomendación incoherente, la métrica falla.
  3. test_case_accuracy_above_080  -> métrica GEval de "accuracy" explícita, threshold 0.80.
  4. test_case_forces_retry        -> el primer intento del modelo es inválido (falta el
     product_id), el AgentLoop lo detecta y reintenta; se evalúa la salida FINAL
     (post-reintento) y debe pasar.
"""

import json
import sys
from pathlib import Path

import pytest
from deepeval import assert_test
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness.env import cargar_env  # noqa: E402
from harness.plugins import AgentLoop, ModelPlugin, NewsItem, StockTool  # noqa: E402

cargar_env()  # OPENAI_API_KEY (juez) y DEEPSEEK_API_KEY (agente) desde .env

STOCK_PATH = Path(__file__).resolve().parent.parent / "stock.json"

NEWS_ITEM = NewsItem(
    titulo="Ribera del Duero celebra una vendimia histórica con Tempranillo de gran calidad",
    resumen=(
        "Los productores de Ribera del Duero, España, destacan una de las mejores "
        "vendimias de la última década para la uva Tempranillo, con vinos de gran "
        "estructura y potencial de guarda."
    ),
    enlace="https://www.wine-searcher.com/m/2026/08/ribera-del-duero-vendimia",
)

accuracy_metric = GEval(
    name="Accuracy",
    criteria=(
        "Comprueba si la respuesta resume fielmente la noticia proporcionada y si el "
        "vino recomendado (product_id) es coherente con el contenido de la noticia "
        "(misma región, uva o tipo de vino relacionado)."
    ),
    evaluation_params=[
        LLMTestCaseParams.INPUT,
        LLMTestCaseParams.ACTUAL_OUTPUT,
        LLMTestCaseParams.EXPECTED_OUTPUT,
    ],
    threshold=0.80,
)


def _stock_context() -> str:
    return StockTool(str(STOCK_PATH)).as_prompt_context()


# ---------------------------------------------------------------------------
# 1) Caso que pasa: recomendación coherente (mismo país/uva que la noticia)
# ---------------------------------------------------------------------------
def test_case_pass():
    actual_output = json.dumps(
        {
            "noticia": {
                "titulo": NEWS_ITEM.titulo,
                "resumen": (
                    "Ribera del Duero ha tenido una vendimia excepcional este año, con "
                    "uvas Tempranillo de gran calidad que prometen vinos con mucho "
                    "cuerpo y capacidad de envejecimiento."
                ),
                "enlace": NEWS_ITEM.enlace,
            },
            "recomendacion": {
                "product_id": "SKU-1002",
                "motivo": (
                    "Vega Sicilia Único es un tinto de Ribera del Duero elaborado "
                    "principalmente con Tempranillo, en línea directa con la noticia."
                ),
            },
        },
        ensure_ascii=False,
    )

    test_case = LLMTestCase(
        input=f"Noticia: {NEWS_ITEM.titulo}. {NEWS_ITEM.resumen}\nStock:\n{_stock_context()}",
        actual_output=actual_output,
        expected_output=(
            "Un resumen fiel de la vendimia de Ribera del Duero y la recomendación "
            "de un tinto de Ribera del Duero elaborado con Tempranillo."
        ),
    )
    assert_test(test_case, [accuracy_metric])


# ---------------------------------------------------------------------------
# 2) Caso que falla: recomienda un vino sin ninguna relación con la noticia
# ---------------------------------------------------------------------------
def test_case_fail():
    actual_output = json.dumps(
        {
            "noticia": {
                "titulo": NEWS_ITEM.titulo,
                "resumen": "Champagne francés bate récords de ventas navideñas.",  # resumen inventado, no coincide
                "enlace": NEWS_ITEM.enlace,
            },
            "recomendacion": {
                "product_id": "SKU-1007",  # Borgoña, Pinot Noir de +4000€: nada que ver con la noticia
                "motivo": "Es nuestro vino más exclusivo, siempre es una buena recomendación.",
            },
        },
        ensure_ascii=False,
    )

    test_case = LLMTestCase(
        input=f"Noticia: {NEWS_ITEM.titulo}. {NEWS_ITEM.resumen}\nStock:\n{_stock_context()}",
        actual_output=actual_output,
        expected_output=(
            "Un resumen fiel de la vendimia de Ribera del Duero y la recomendación "
            "de un tinto de Ribera del Duero elaborado con Tempranillo."
        ),
    )
    with pytest.raises(AssertionError):
        assert_test(test_case, [accuracy_metric])


# ---------------------------------------------------------------------------
# 3) Caso con accuracy explícitamente > 0.80 (mismo metric, distinto foco: exactitud del resumen)
# ---------------------------------------------------------------------------
def test_case_accuracy_above_080():
    strict_accuracy_metric = GEval(
        name="StrictAccuracy",
        criteria=(
            "Puntúa 1.0 solo si el resumen no inventa ningún dato que no esté en la "
            "noticia original y el product_id recomendado existe realmente en el stock "
            "proporcionado. Puntúa 0.0 si inventa datos o el product_id no existe."
        ),
        evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
        threshold=0.80,
    )

    actual_output = json.dumps(
        {
            "noticia": {
                "titulo": NEWS_ITEM.titulo,
                "resumen": NEWS_ITEM.resumen,  # resumen fiel, sin inventar datos
                "enlace": NEWS_ITEM.enlace,
            },
            "recomendacion": {
                "product_id": "SKU-1002",  # existe en el stock
                "motivo": "Vega Sicilia Único es Tempranillo de Ribera del Duero, la misma región de la noticia.",
            },
        },
        ensure_ascii=False,
    )

    test_case = LLMTestCase(
        input=f"Noticia: {NEWS_ITEM.titulo}. {NEWS_ITEM.resumen}\nStock:\n{_stock_context()}",
        actual_output=actual_output,
    )
    assert_test(test_case, [strict_accuracy_metric])
    assert strict_accuracy_metric.score >= 0.80


# ---------------------------------------------------------------------------
# 4) Caso que se queda corto en el primer intento y fuerza un reintento del agente
# ---------------------------------------------------------------------------
class _FlakyThenGoodModel(ModelPlugin):
    """Modelo que en el primer intento devuelve una salida incompleta (sin product_id)
    y en el segundo intento (tras recibir feedback de corrección) responde bien.
    Simula un modelo real que "se queda corto" y necesita que el AgentLoop reintente."""

    def __init__(self):
        super().__init__(mock=True)
        self.call_count = 0

    def complete(self, system_prompt: str, user_prompt: str) -> str:
        self.call_count += 1
        if self.call_count == 1:
            # Respuesta corta / incompleta: falta recomendacion.product_id
            return json.dumps(
                {
                    "noticia": {"titulo": NEWS_ITEM.titulo, "resumen": "Vendimia buena.", "enlace": ""},
                    "recomendacion": {"motivo": "No estoy seguro de qué vino recomendar."},
                },
                ensure_ascii=False,
            )
        # Segundo intento, ya con el feedback de corrección en el prompt: respuesta válida
        return json.dumps(
            {
                "noticia": {
                    "titulo": NEWS_ITEM.titulo,
                    "resumen": NEWS_ITEM.resumen,
                    "enlace": NEWS_ITEM.enlace,
                },
                "recomendacion": {
                    "product_id": "SKU-1002",
                    "motivo": "Vega Sicilia Único: Tempranillo de Ribera del Duero, coherente con la noticia.",
                },
            },
            ensure_ascii=False,
        )


def test_case_forces_retry():
    stock_tool = StockTool(str(STOCK_PATH))
    flaky_model = _FlakyThenGoodModel()
    loop = AgentLoop(model=flaky_model, rss_tool=None, stock_tool=stock_tool, max_attempts=2)

    result = loop.run(NEWS_ITEM)

    # El agente debió necesitar 2 intentos y terminar en una salida válida
    assert result.attempts == 2
    assert result.valid is True
    assert flaky_model.call_count == 2

    test_case = LLMTestCase(
        input=f"Noticia: {NEWS_ITEM.titulo}. {NEWS_ITEM.resumen}\nStock:\n{_stock_context()}",
        actual_output=json.dumps(result.output, ensure_ascii=False),
        expected_output=(
            "Un resumen fiel de la vendimia de Ribera del Duero y la recomendación "
            "de un tinto de Ribera del Duero elaborado con Tempranillo."
        ),
    )
    assert_test(test_case, [accuracy_metric])
