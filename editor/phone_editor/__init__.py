# Serves the phone-friendly editor page at /editor. Adds no nodes.
import os

from aiohttp import web
from server import PromptServer

EDITOR_HTML = os.path.join(os.path.dirname(__file__), "editor.html")


@PromptServer.instance.routes.get("/editor")
async def editor_page(request):
    return web.FileResponse(EDITOR_HTML, headers={"Cache-Control": "no-store"})


NODE_CLASS_MAPPINGS = {}
