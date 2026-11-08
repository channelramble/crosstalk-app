# The image editor's phone page

Crosstalk can optionally switch a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image editor on and
off from Settings → Image editor. The hub looks for it in `<workspaceRoot>/ai-models/image-editor`: a folder
holding a ComfyUI checkout and a `start.sh` that `exec`s ComfyUI's server (the port comes from its `--port`,
8188 when none is given). Without that folder, nothing else in Crosstalk changes.

The page people use on their phones is a ComfyUI custom node, kept here so it is version controlled:

```
editor/phone_editor/__init__.py    serves the page at GET /editor (Cache-Control: no-store). Adds no nodes.
editor/phone_editor/editor.html    the whole phone UI: photo, paint, words, Edit, progress, result, Clear.
```

The page builds a Qwen Image edit workflow and needs the
[ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) nodes (`UnetLoaderGGUF`, `CLIPLoaderGGUF`). The model files
it loads are named in the `MODELS` constant near the top of the page's script; put matching files in ComfyUI's
`models/` folders, or change those names to the ones you have.

`hub/src/editorSource.ts` embeds both files into the hub binary (`with { type: "text" }`) and can put them
into the install; `hub/src/imageEditor.ts` calls it. **Nothing there ever starts, stops or signals a
server.** See `docs/IMAGE-EDITOR.md` for how the shared edit session works.

## Which part waits for the next ComfyUI start

| File | When it takes effect | Why |
|---|---|---|
| `editor.html` | the next time a device opens `/editor` | `__init__.py` reads the file for every request and serves it `no-store` |
| `__init__.py` | the next time **ComfyUI** starts | Python imports custom nodes once, at start-up |

The page's design is deliberately built so **nothing waits**: the shared session is kept through
ComfyUI's own `GET/POST/DELETE /userdata/{file}` (claims through its `POST /userdata/{file}/move/{dest}`),
followed through its own `/queue` and `/history/{prompt_id}`, and stopped with its own
`POST /api/jobs/{id}/cancel`. No new route, so `__init__.py` only ever needs to be installed once and later
changes touch only `editor.html`. `hub/test/editor-source.test.ts` fails if a new route is ever added here
without that being noticed.

## Installing it by hand

```sh
R=/path/to/crosstalk                                     # this repository
E=$COMFYUI_DIR/custom_nodes/phone_editor                 # e.g. ~/ComfyUI/custom_nodes/phone_editor

mkdir -p "$E"
cmp "$R/editor/phone_editor/__init__.py" "$E/__init__.py" || cp "$R/editor/phone_editor/__init__.py" "$E/"   # a change here needs a ComfyUI restart
cp  "$R/editor/phone_editor/editor.html" "$E/editor.html"   # live on the next page load
```

Then open `http://<comfyui-host>:8188/editor` on the phone. Updating `editor.html` later needs no restart, no
model reload, nothing queued: reload `/editor`.

## What the hub does on its own: nothing

The hub does **not** put this page into the install by itself. `ImageEditor` writes it only when its
`syncPage` dependency asks for it, and `hub/src/app.ts` deliberately does not set it. The installed page may be
one someone edited by hand, and replacing it changes what their phone is served at the next reload, so
applying it is the copy above, at a moment a person picks.

The machinery is there for whenever that is wired up, and it is careful: only the files that differ, each
written beside its place and moved over it so a page load can never read half a file, what it replaced kept
as `<name>.replaced`. **While someone's edit is queued or running the page is left alone**, and so it is when
the server can't say whether one is (an unreadable `/queue` counts as busy — a server loading ~10 GB of
models blocks its own event loop exactly when an edit is likely running). It goes in at a later look instead.

## `original/` — the first, single-device page

`editor/original/{editor.html,__init__.py}` is the earlier version of the page: one device at a time, with no
shared session (the photo lives only in that browser's canvas). It is kept for reference and as a minimal
example of driving the same workflow from a browser. To use it instead, copy `original/editor.html` over the
installed `editor.html` the same way; it is live on the next page load. Doing so discards whatever the shared
session currently shows.
