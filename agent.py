"""
Agente de ejemplo: lee el RSS de noticias de Wine-Searcher, resume la última
noticia y recomienda un vino del stock de la tienda. Imprime un JSON final con
la forma:

{
  "product_id": "SKU-XXXX",
  "noticia": {"titulo": ..., "resumen": ..., "enlace": ...},
  "recomendacion": {"product_id": ..., "motivo": ...},
  "meta": {"intentos": N, "valido": true/false}
}

Uso:
    export DEEPSEEK_API_KEY=sk-...   # opcional; sin ella corre en modo mock
    python agent.py
"""

import json
import sys
from pathlib import Path

from harness.plugins import AgentLoop, ModelPlugin, RSSFeedTool, StockTool

STOCK_PATH = Path(__file__).parent / "stock.json"


def run_agent() -> dict:
    rss_tool = RSSFeedTool()
    stock_tool = StockTool(str(STOCK_PATH))
    model = ModelPlugin()  # usa DEEPSEEK_API_KEY si existe; si no, modo mock
    loop = AgentLoop(model=model, rss_tool=rss_tool, stock_tool=stock_tool, max_attempts=2)

    news_items = rss_tool.fetch_latest(n=1)
    if not news_items:
        raise RuntimeError("No se encontraron noticias en el feed RSS")

    result = loop.run(news_items[0])

    final = {
        "product_id": result.output.get("recomendacion", {}).get("product_id"),
        "noticia": result.output.get("noticia"),
        "recomendacion": result.output.get("recomendacion"),
        "meta": {"intentos": result.attempts, "valido": result.valid, "errores": result.errors},
    }
    return final


if __name__ == "__main__":
    try:
        output = run_agent()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(output, ensure_ascii=False, indent=2))
