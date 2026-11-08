# The image editor: one shared edit

Crosstalk can optionally work with a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI) install as an
image editor. Settings → Image editor switches that ComfyUI on and off (`hub/src/imageEditor.ts`). What people
use is a phone-friendly page served at `/editor` by a small ComfyUI custom node, kept in the repository at
`editor/phone_editor` (see `editor/README.md` for the files and how they are installed). The integration is
entirely optional: without a ComfyUI install, the rest of Crosstalk is unaffected.

The page keeps **one shared edit session**: leave it on one device, come back on another, and it shows the same
photo, the same running edit and the same result, until someone clears it and starts a new edit. This document
describes how that works.

## Why a shared session

A page that makes a fresh random client id on every load, subscribes to `/ws` with it and queues with it turns
every other device — or the same device after a reload — into a different session: it does not follow a running
edit and never sees its result, and the photo being worked on exists only in one browser's canvas.

## Where the session lives

In **one file on the server**, written and read through ComfyUI's own user data store:

```
GET    /userdata/crosstalk-editor-session.json      the session (404 = there is none)
POST   /userdata/crosstalk-editor-session.json      write it (overwrite is the default)
DELETE /userdata/crosstalk-editor-session.json      Clear
POST   /userdata/crosstalk-editor-claim.json?overwrite=false    take the "one edit at a time" claim (409 = held)
```

Those routes already exist (`ComfyUI/app/user_manager.py`), so **no new route and no restart**: copying
`editor.html` over is picked up on the next page load. With `--multi-user` off (the default) the store is
`ComfyUI/user/default/`, the parent folder is created on the first write, `overwrite=false` answers 409
when the file is there, and the body limit is `--max-upload-size` (100 MB by default) — far more than
needed.

**Only ids, words, filenames, sizes and times go in that file.** Its fields are `sid` (the session's own id),
`rev`, `by`/`byName`, `at`, `token`/`lineage` (the last 32 writes, see below), `image`, `prompt`, `detail`, `job`,
`result`, `undo` (at most 5), `done`, `stopped`. The prompt is capped at 2,000 characters and nothing else grows,
so the file stays a few KB.

A **job** records everything needed to finish it without the page that started it: `id` (also ComfyUI's
`prompt_id`), `by`/`byName` (the device), `client` (the page that submitted it, so only it reads step progress),
`at`, `queued` (`false` from when it is recorded until it has reached ComfyUI, then the time it did), `prompt`,
`seed`, `resolution`, `crop` (where in the photo the model's picture goes), `whole` (nothing was painted), `base`
(the photo it started from), `input` (the crop it uploaded for the model), `mask` (the painted area it uploaded, or
null with `maskLost` saying why), `prev` for Edit again (the result it is to replace, put back if it makes none),
and `stopping` once ComfyUI has taken a stop for it. A **result** keeps the
model's own picture (`out`), the photo it made (`image`, or none when it couldn't be blended in: `plain` with `why`),
the `crop`, `whole` and `mask` it used (so Edit again can repeat it), and who finished it (`finishedBy`).

Pictures stay where ComfyUI already keeps them. The working photo, the crop for the model and the painted area
are uploaded with `POST /upload/image` into `input/crosstalk-editor/`, results are saved in `output/phone_edit/`,
and every device reads them back with `GET /view?filename=…&subfolder=…&type=…` (plus a `v` of the page's own, which
ComfyUI ignores and the browser's cache doesn't: names are reused, see "input/ stays small"). The working photo is
capped at **2048** on the long side (`SHARED_MAX_SIDE`) rather than 4096, because it travels to every device: a
phone photo is then about 3–5 MB per step. The edit itself is unchanged — the crop sent to the model is still scaled
to about 1.5× the chosen resolution — so only the untouched surroundings lose resolution. One constant reverts that.

A result is saved as `output/phone_edit/<job id>_00001_.png`: the workflow's `SaveImage` prefix is
`phone_edit/<job id>`, and `folder_paths.get_save_image_path` numbers a prefix nobody else uses from 1. So a job
that finished while nobody watched is found **even after ComfyUI restarted** and forgot it (its history lives in
memory only): a job in neither `/history` nor `/queue` is first looked for there (`HEAD /view`), and only then
called gone.

## Following an edit you didn't start

`ComfyUI/server.py` does `self.sockets[sid] = ws` and **drops the old socket with the same id**, so two
devices cannot share one websocket id: the second would evict the first. Execution events (`executing`,
`progress`, `executed`, `execution_error`) are sent to the submitting client's id only; `status` is the one
that broadcasts.

So each page subscribes under its own id (`<device>.<tab>`, so two tabs on one device don't evict each
other either), and every device follows the running job by polling:

* `GET /history/{prompt_id}` — an entry with `outputs["8"].images[0]` is done; `status.status_str == "error"`
  carries `execution_error` and its message.
* `GET /queue` — `queue_running` / `queue_pending` by `prompt_id`, for "editing" and "waiting behind N".
* In **neither**, three polls running → the job is **gone**: ComfyUI restarted or its queue was cleared. The
  page says so, with Try again, instead of spinning for ever. A job still marked `queued: false` hasn't reached
  ComfyUI yet, so it is in neither by right: it gets a minute (`QUEUE_GRACE_MS`, by its `at`) before that count
  starts, with "Starting on Phone…" meanwhile. One that never turns up is said to have "never reached ComfyUI: the
  page on Phone closed or lost its connection before sending it", not that ComfyUI restarted.

Step-by-step progress exists only for the device that submitted, and the page says the plainer thing on the
others ("Editing on Phone… 12 s so far") rather than pretending to know the step. The broadcast `status`
event is used as a free nudge to read the session again.

The job id is the page's own: `POST /prompt` takes a client-supplied `prompt_id` when it is a canonical
lowercase UUID (`comfy_execution/jobs.py` `validate_job_id`), so the claim and the job are the same id.
`crypto.randomUUID` is not used — the page is also served over plain http on Tailscale, which is not a
secure context — `crypto.getRandomValues` is.

## Two devices at once

**Writes: rebased, checked, and put back when another write lands over them.** Every change is applied to the
session as the server has it right then (read just before the write), so a one-field change never carries a stale
copy of the others. A page's own changes go one at a time. Each write adds its random `token` to the session's
`lineage`. A write that started before another and landed after it drops that token, and the page that made the lost
write sees so on its next read (it checks its writes for 15 seconds): it puts back what it had changed, field by
field, wherever the field still holds what it held before — a field someone else changed meanwhile stays theirs. So a
photo chosen on the phone survives the laptop's typing landing in the same moment, and the laptop's words survive
too. This is done only inside the session the write was made in (its `sid`), over the session it replaced, or over a
session another device started from nothing in the same moment; a session someone started later on purpose (a new
photo) is never patched with older writes. A Clear that a late write brought back is cleared again.

**Typing: last one wins, but never under your hands.** Words are shared 800 ms after you stop typing, or at once
when you leave the box. If words arrive while your own box has the focus, or before your own words have reached the
server, yours stay and a line offers theirs with a "Use their words" button. Otherwise theirs appear. The Detail
choice is kept the same way until the server has it.

**Edit: the edit already running wins; the second is refused and told.** Not last-one-wins, because an edit
costs real GPU time and a second run would replace the result the first device is waiting for. Two layers:

1. Pressing Edit re-reads the session from the server first (not what the page last saw). A `job` there →
   "An edit is already running (started on Laptop)."
2. The claim is taken **atomically**: the page writes the claim under a name of its own and then moves it onto
   `crosstalk-editor-claim.json` with `POST /userdata/{file}/move/{dest}?overwrite=false`. ComfyUI's move handler
   (`app/user_manager.py`) checks the destination and moves with nothing awaited in between, so exactly one page
   wins however close together they ask; the others get 409 and are told who is starting an edit. (The earlier
   `?overwrite=false` write had an `await request.read()` between its check and its write.) A ComfyUI without the
   move route falls back to that write and reading it back.

The job is written into the session **before** it is queued, so a page that goes away after queueing can never
leave an edit nobody follows; if the server won't save the session, nothing is queued and the page says so. Once
`POST /prompt` has taken it, the page writes `queued` and reads the session back: if the job isn't there any more —
another device stopped it, cleared the edit, or gave up on it while this phone was locked between the two steps —
the page cancels it in ComfyUI ("This edit reached ComfyUI too late…"), so nothing runs that nobody follows; if
the session can't be read then, the next read checks. When `POST /prompt` gets no answer, ComfyUI's queue and
history say whether it arrived; when they can't say either, the job stays recorded as not sent and the rule above
decides. Why a job didn't get recorded is said as what happened (an edit already running, the edit cleared or
changed on another device, a refused write), never as a disk problem it wasn't. A claim
whose device went away before recording its job is set aside after 90 seconds (moved under a name only that claim
has, so of two pages doing it at once, one can) and taken; `Clear` deletes it.

## Finishing: the way back to an edit

A finished edit must not be blended through a page's **own in-memory paint**: a device id outlives a reload (it is
in `localStorage`), the paint does not, so a device coming back after closing the tab, locking the phone or
reloading would blend the result through an empty mask and share the untouched photo as "Done".

So **nothing about a finished job comes from the page's canvas.** Whoever finishes it — the page that started
it, the same device after a reload, another device, or the first page opened after nobody was watching — loads
from the server the photo the job started from (`job.base`), the painted area it uploaded (`job.mask`) and the
model's picture, and blends them at the job's recorded `crop` (soft edge, as before). A whole-photo edit takes the
model's picture over the whole photo. The new photo is uploaded, pushed onto the shared undo list, and every
other page adopts it from the session.

**Exactly one page finishes a job.** It first takes that job's finish claim, `crosstalk-editor-finish.<job>.<try>.json`,
with the same atomic move; every other page shows "Finishing on Laptop…" and picks up the finished photo when the
session has it. The page that submitted the job goes at once; any other waits 1.5 s for it first. A claim whose page
went away (a phone locked half-way, say) is given up on after 45 seconds of watching it, or when it is three minutes
old, and the next try (`<try>` + 1) is anyone's; a late finish by the first page then changes nothing, because the
session write checks whether that job's result is already in. That page also puts it in once: its looks at the
session overlap (ComfyUI's events at the end of an edit each start one), and a look that finds the edit done while
the page is already putting it in leaves it alone (`puttingIn`). Such a look used to blend and upload the photo again.

**When ComfyUI won't save** — the finish claim or the session write is refused (a full disk, a read-only user
folder) — the result is still loaded and blended from the server's pictures and shown on every device that is open,
with Save and **See what the model made**, and "ComfyUI can't save right now (403), so your other devices don't
have this result yet. Free up disk space on the computer running ComfyUI, then tap Try again." Sharing it is the
step that is retried (every 30 s, at once with Try again); the blend isn't redone, and an upload already made is
reused. Stop isn't offered for an edit that has finished.

**When the painted area isn't on the server** — its upload failed when the edit started (the page asks first:
"Edit without blending?"), or the file has gone since — nothing is blended. The page says "Done, but not blended
in", says why, keeps the photo as it was, and offers **See what the model made**: the model's own picture, to look
at or save. A picture that couldn't be fetched for a moment is not "gone": only a 404 counts, anything else is
tried again shortly (and at once with Try again).

`Undo` and `Hold: before` are shared too — the session keeps up to 5 earlier photo references — so undo
works on whichever device you are holding. **Edit again** edits the same area (`result.crop`, through the same
uploaded paint, `result.mask`) of the photo from before that edit, with the words in the box. The session changes
only in the write that records the new job — that write puts the earlier photo back — so an Edit again that doesn't
start (ComfyUI refusing it, no answer, another device starting one) leaves the finished result exactly where it
was. One that starts and then fails, is stopped or is gone puts it back (`job.prev`), and its Try again is Edit again.
If the painted area isn't on the server any more it says so and asks for new paint, rather than quietly editing the
whole photo.

## Stopping

While an edit runs, every device shows **Stop this edit**. It asks first ("Stop this edit? ComfyUI stops working
on it. Your photo stays as it was." — Keep editing / Stop it), then sends ComfyUI's own `POST
/api/jobs/{id}/cancel` (`server.py`) **before writing anything**: a waiting job is taken out of the queue, a running
one interrupted, and `{"cancelled": false}` comes back for one that had already ended. Only what ComfyUI did is then
written down, so a page that goes away half-way (a phone locked right after "Stop it") never leaves every device
showing a stop nobody sent — the others still offer Stop.

ComfyUI doesn't stop a running edit at once: `interrupt_if_running` sets `nodes.interrupt_processing`, which is
checked between nodes and as each layer is queued (`comfy/ops.py` `run_every_op`, which the GGUF layers inherit).
On a GPU a step's layers are queued well before they run, so in practice it stops once the step it is on is done —
a minute or two on a typical machine, far longer when it swaps — or once a model it is loading is in. So a running edit is marked `stopping` and **followed until `/history` shows
`execution_interrupted`**: every device says "Stopping on Laptop… ComfyUI stops after the step it's on, which can
take a few minutes.", Stop is greyed out, and Edit stays unavailable. Then "Stopped on Laptop. The photo is as it
was." An edit that finished just before the stop keeps its result ("It had already finished, so its result is going
in."). An edit started after a Clear that stopped one waits with "Waiting for the stopped edit to end…" rather than
an unexplained place in the queue.

A ComfyUI without the jobs routes is stopped with `POST /queue {"delete": [id]}` while the job waits and `POST
/interrupt {"prompt_id": id}` only while `/queue` shows it running: before targeted interrupts ComfyUI ignored the
`prompt_id` and interrupted whatever ran, which could be someone else's edit or the hub's warm-up.

## Clear

One control, `Clear & start new edit`: it deletes the session file and the claim, and every device resets
within a poll ("Cleared on another device"). It asks first, on what the server says right then, when an edit is
running or a result would be lost, and only then. **With an edit running the question is whether to stop it**
("An edit is running (started on Phone). This stops it, and the photo, the words and the result go, on every
device." — Keep it / Stop it and clear): Clear no longer deletes the session and leaves the edit going with nothing
waiting for its result. Choosing a new photo goes through the same question. With a result or undo steps to lose
it says "Save any photo you want to keep first: the server keeps only the last few." — names are reused (see below),
so it no longer promises the pictures stay. The mask button is `Clear paint`, which only clears the painted area on
that device.

## Honest about what is there

* A session that points at an output or input file that is gone: "The photo this edit was working on is not
  on the server any more", with Clear & start new edit as the way out.
* A session the server refuses to write (a 403 from `/userdata`): the photo stays on screen ("It's still here
  on this device"), and `Share again` retries. That holds when the session already had a photo too: the new one
  stays over it while it is unshared, and painting and Edit act on what is on screen. Pressing Edit then keeps the
  photo and the words — it used to empty both — and says the photo isn't shared, with **Share and edit** doing both
  in one tap. If another device changes the edit meanwhile (another photo, an edit started), theirs stands and the
  page says the new photo wasn't shared.
* A job ComfyUI no longer knows about and that saved nothing: said to be gone, with Try again. The page drops it
  from its own view at once, even when the server won't take the tidy-up, so it is never stuck behind a dead job;
  the next write that does go through removes it from the session too.
* An edit that fails says ComfyUI's own words with Try again; the painted area stays for the retry.
* A picture that reaches the server empty or cut short is sent again, and never shared. WebKit was seen sending an
  upload's form with the picture left out — in the tests, under load, for a photo that had just been drawn on screen
  (the chosen photo, the finished one): ComfyUI then keeps an empty file and answers 200, and every other device said
  the photo was gone. So what the server kept is checked against what was sent (ComfyUI's `asset.size` when it gives
  one, otherwise `HEAD /view`'s Content-Length); after three tries it says the picture didn't reach the server whole.
* `/userdata` is read with a cache-busting query and `cache: 'no-store'`, because ComfyUI sets no
  `Cache-Control` on it (`middleware/cache_middleware.py` only touches `.js`, `.css`, `index*.json` and
  image paths) while aiohttp's `FileResponse` does send `Last-Modified`/`ETag`.

## input/ stays small

The page used to upload under a new name every step (`base_<time>.png`, `edit_…`, `mask_…`): roughly three
multi-megabyte pictures per edit into `input/`, and nothing ever removed them. ComfyUI has no route to delete a
file from `input/` (and a new one would wait for a restart), so the page **reuses names** instead: each device
uploads into `input/crosstalk-editor/` as `<device>-base-<n>.png` (n going round 8), `-crop-<n>` (3) and `-mask-<n>`
(4). Before it writes over a name it reads the session and skips every name the session still points at — the photo,
the 5 undo steps, the running job's photo, crop and painted area, the last result's photo and painted area — and the
photo this page is still trying to share. If all of a kind are in use (they can't be: 8 bases against at most 6
referenced) it uses a fresh name rather than write over one. So `input/crosstalk-editor/` holds at most 15 pictures
per device, whatever the number of edits, and never loses one the session or its undo history needs. The
`v=` on every `/view` address keeps a reused name from showing an older picture out of the browser's cache.

Pictures the older page left at the top of `input/` are not touched. Results in `output/phone_edit/` are kept, one
per edit, as ComfyUI keeps every result.

## How much detail the model gets

Under the photo, two short lines that stay put (so painting never moves the buttons): what Edit will send —
"Editing a 384×402 area → sent at about 1328 px" (or "Whole 2048×1536 photo → …" with nothing painted) — and, when
the model gets fewer pixels than the painted area has, a yellow tip: "Big area: detail is lost. Paint tighter or
zoom in." Every phone photo is bigger than what the model gets, so the whole-photo advice ("Whole photo: fine detail
is lost. Paint just the part to keep it.", in the dim colour) is only shown when an unpainted edit is about to go:
words typed, nothing painted, and not the words of the result just shown. The
number is the size `TextEncodeQwenImage21` works at: about resolution², at multiples of 32, rounded the way Python's
`round` does (a 384×384 area at High is 1344, not 1328). It follows the paint as you go, the Detail choice, and the
photo.

## Keeping the page in the repository

`hub/src/editorSource.ts` embeds `editor/phone_editor/{editor.html,__init__.py}` into the hub binary and
writes into the install only what differs, each file written beside its place and moved over it. What it
replaced is kept as `<name>.replaced`. Nothing is ever started, stopped or signalled.

**The hub does not do this on its own.** `ImageEditor` only writes the page when its `syncPage` dependency
asked for it, and `hub/src/app.ts` deliberately does not set it. The installed page belongs to whoever runs the
ComfyUI: it may be one they edited by hand, and replacing it changes what their phone is served at the next reload, so that is a
moment a person picks — not something a hub restart does behind them. Applying it is the copy under
"Applying it by hand" in `editor/README.md`.

When something does ask for it, the write is still held back: it is called from `ImageEditor.start()`, from
switching the editor on, and from the watcher while a write is still owed — never awaited, so it can't hold up
a start, a stop or a status answer. **While someone's edit is queued or running the page is left alone**, and
so it is **when the server can't say whether one is**: `/queue` failing or timing out counts as busy, because a
server loading ~10 GB of models blocks its own event loop exactly when an edit is most likely to be running.
The page goes in at a later look instead, so it can never be swapped under a running edit.

`editor.html` is live on the next page load; `__init__.py` only matters when ComfyUI next starts, and the
hub log says which of the two it was.

## Tests

| Where | What |
|---|---|
| `hub/test/editor-source.test.ts` | 10 tests: the two files and which one waits; **that the page needs no new route** (every route `__init__.py` registers is listed and must stay just `GET /editor`; the page's claims and Stop use ComfyUI's own move and cancel routes); the warm-up still loads exactly the page's models; a folder that isn't an install; a fresh install; nothing done twice; a hand-edited page kept as `.replaced`; the hub putting the page in only when asked, without starting a server; the page left alone under a running edit, and while the server can't say |
| `web/e2e/editorSession.spec.ts` | 38 tests against the real `editor.html`, on every project the suite runs (Chromium and WebKit, 320–1440 px). They paint as on a 390 px phone whatever the screen: `paint()` sets Brush to cover the photo pixels 36 px covers there (the slider's 120 at 1440) and scrolls the photo's box to the stroke, since zoom 1 fits the photo to the box's width and on a wide screen it is taller than the box. **The way back:** a device closed for the whole edit and reopened gets the edited photo, blended through the uploaded paint at the job's crop and scale (pixels checked: inside the painted dot each pixel is the edit's own and made from that very pixel of the photo, so a composite 12 px off or not scaled back fails; 18–20 px outside the paint on every side, beside it and far away, the photo is exactly as it was); the same edit brought back by another device opened afterwards, and the first device finding it there without putting it in twice; a reload mid-edit; moving to another device mid-edit; two devices open when it finishes (both reloaded, so they race for it: one finishes, one photo uploaded); two tabs on one device; one page putting it in once when two of its looks find it done together (each held at `/history`, the second let through while the first uploads); a whole-photo edit; the painted area never reaching the server (asked first, then "not blended in", the photo untouched, the model's picture offered); an edit that finished just before ComfyUI restarted. **Sending:** an edit slow to reach ComfyUI (7 s) isn't called gone by the other device ("Starting on Phone…"), and finishes; one whose page went away before sending it is said to have never reached ComfyUI, and when it turns up after all it is cancelled. **Stop:** from the device that didn't start it, with its question, said to be stopping (Stop greyed out on both) until ComfyUI finishes its step (`holdStop`); a stop that never left the phone doesn't lock Stop on the laptop; Clear asking to stop a running edit; a ComfyUI without the jobs routes (the running edit interrupted; a waiting one dequeued without interrupting someone else's edit ahead of it, on a ComfyUI whose `/interrupt` ignores `prompt_id`). **Detail:** the readout, High's 1344, the yellow tip for a big painted area, the dim whole-photo advice only once words are typed (not on loading, not after a result), and the Edit button not moving. **The reviews' findings:** Edit with `/userdata` refused keeps the photo and the words; a photo surviving the other device's typing landing at the same moment (`stallMs`); a gone edit while writes are refused not pinning the page; Edit again re-editing the painted area; an Edit again that's refused, or fails, keeping the result exactly; an edit finishing while ComfyUI won't save shown on both devices with Save and See what the model made, then shared once by Try again; a new photo the server wouldn't share staying on screen until another device changes the edit; a picture that reaches the server empty sent again, never shared empty (`emptyOnce`); `input/` holding a bounded set of reused names and every undo step still its own picture after nine edits; a failed edit (`editError`); a refused edit (`reject`). And the earlier eight: one session on two devices; a result on the device that didn't start it; words offered not overwritten; Clear and its question (and what it says about the server's pictures); an edit the server forgot; two devices pressing Edit at the same moment; the session surviving a reload and a ComfyUI restart. `CROSSTALK_EDITOR_PAGE=<file>` runs it against another copy of the page, to see a deliberately broken one fail |
| `hub/test/fixtures/fake-comfy-editor.ts` | the stand-in: `/editor`, `/system_stats`, `/ws` (one socket per client id, the old one dropped, events to the submitter only, `status` and `execution_interrupted` to all), `/prompt` (client-supplied UUID `prompt_id` validated as the real one does, and the graph checked for known nodes, real links and LoadImage's file with its subfolder), `/queue`, `/history/{id}` (with `execution_start`/`_success`/`_error`/`_interrupted` messages and timestamps), `/api/jobs/{id}/cancel`, `/interrupt`, `/upload/image`, `GET`/`HEAD /view`, `/userdata` with its move route, and every route under `/api` too — shapes read out of ComfyUI 0.42.0's `server.py`, `execution.py`, `comfy_execution/jobs.py`, `folder_paths.py` and `app/user_manager.py`. An edit makes the picture it was sent, scaled to the size the model works at, keeping its red and green and setting its blue (`editBlue`), saved under SaveImage's name: put back in the photo, each pixel says which pixel of the photo it was made from (`editColor` paints one colour instead). Its PNG reader takes what a browser's `toBlob` makes (8-bit, any filter). An edit is `steps` steps, and a stop is honoured only at the end of the step it lands in (`holdStop` holds it there), as ComfyUI's is. Pictures and the session are files in its own folder, so a restart keeps them. Its `fake-comfy-editor.json` sets `editMs`, `steps`, `holdStop`, `editError`, `editBlue`, `editColor`, `reject`, `userdataWrite`, `uploadFail`, `emptyOnce` (the first upload of a name kept empty, as when WebKit leaves the picture out), `lose` (forget every job, as a restart does), `stallMs`/`stallFile`, `noMoveRoute`, `noCancelRoute`, `oldInterrupt` (`/interrupt` ignoring `prompt_id`, as before targeted interrupts); `GET /__fake/log` lists what it was asked |

"Devices" in the spec are separate browser contexts with their own `localStorage`, so each has its own
device id and its own websocket id. The stand-in runs on a free port from a temporary folder; a real ComfyUI
install is never asked anything.
