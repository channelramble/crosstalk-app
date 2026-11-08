# Local models: getting models, "fits this machine?", starting and stopping servers

Settings → Local models: getting models and running servers, beyond the list of running models and their switches.
Built and tested against fakes only: no real Hugging Face download, Ollama, llama-server or Ollama library was used.

## What it does

- **Get a model** (`hub/src/localLibrary.ts`; web `views/LocalModelsGet.tsx`): search Hugging Face for GGUF models (or paste a
  link), then a repo's files, each with its size, quant and a verdict at the chosen context (32k, 64k, 128k): **Fits** (up to
  85% of what the machine can give), **Tight** (to 100%), **Slow** (a PC whose GPU is too small but whose memory holds the
  rest: llama.cpp puts layers on the processor), **Too big**. The file to pick is marked (the biggest of Q8_0, Q6_K, Q5_K_M,
  Q4_K_M that fits, else the biggest that fits); files below 4 bits say they're less accurate. Or a name from Ollama's
  library, whose size and quant are read from the library before it's pulled into an Ollama on 127.0.0.1.
- **What a model needs**: the file, plus its KV cache at the context, plus 1 GB (llama.cpp's headroom). The KV cache per token
  is read from the GGUF header (`hub/src/gguf.ts`: the first megabyte of the smallest file, a Range request; layers that only
  see a sliding window aren't counted per token in the families llama.cpp windows (Gemma 2/3/3n, gpt-oss, Command R7B,
  Llama 4); a window in another family's header (Phi-3) counts every layer; MLA and hybrid models are handled); 128 KiB a
  token when it can't be read. A model trained for less than 32k is offered, counted and started at its own context.
- **What the machine can give** (`machineFrom`): on Apple silicon, Metal's working set as llama.cpp reports it (the pool's
  install, else a llama-server found here; listing it never touches a helper), else about 2/3 of the memory up to 36 GB and
  3/4 above, marked "about"; on a PC, the GPUs' free memory; without a GPU, the memory less a quarter (at least 4 GB).
- **Downloads**: the model pool's downloader (`pool/models.ts`, now with a `root` folder argument; the pool's own default is
  unchanged): resumable `.part` files pinned to one commit, the hub's reserve kept free before and during (507 `low_disk`
  with "Free up space, change the folder, or pick a smaller file"; what downloads already running on the same disk still
  need is counted first), Stop (keeps what's downloaded), Resume, Remove. Up to 3 at once. One file is downloaded by one
  downloader at a time (`downloadingBy`, `DOWNLOADERS`): the pool and Local models share the default folder, and each is
  told plainly while the other writes a file. Remove of a download the pool finished meanwhile only forgets it. Kept in kv
  `localModels.downloads`; one running when the hub stops (or crashes) carries on when it starts again
  (`resumeInterrupted`, from `App.start`, never in in-memory hubs). Ollama pulls stream `/api/pull` progress; Stop ends
  the request (Ollama keeps its part, unless an Ollama starts meanwhile without `OLLAMA_NOPRUNE`). The disk watched is
  the one Ollama writes to: an Ollama Crosstalk started has the hub's settings (`OLLAMA_MODELS`, else `~/.ollama/models`);
  for another, the place (those two, and the Linux service's `/usr/share/ollama/.ollama/models`) where the `-partial`
  file of the layer it's downloading appears. When none does, the download says its disk isn't watched (`note`).
- **Remove** (`toTrash`): to the Trash, never deleted outright and never copied. A file on another drive goes in that drive's
  own Trash (the Finder's `<drive>/.Trashes/<uid>`, freedesktop.org's `<drive>/.Trash-<uid>` or an administrator's
  `.Trash/<uid>`); when that can't be used it stays, 409 `no_trash`, and the page offers **Delete for good**, which asks
  again before it sends `forGood`. A second Remove of the same model waits for the first.
- **The folder** (kv `localModels.folder`; default `~/.crosstalk/models`, the pool's): any folder the hub can write to (made if
  missing, checked with a real write from a child process in its own process group, answered at its time limit: macOS may
  hold the write for a question on its screen). Under `/Volumes`, `/media`, `/run/media` or `/mnt`, a path on a mounted
  drive (its real mount point, `/mnt/data/disk2` too) is on that drive; one whose drive folder the system makes and takes
  away (`/Volumes/<name>`, `/media/<user>/<name>`, `/run/media/<user>/<name>`) is missing or left on this disk, or under an
  fstab mount point that isn't mounted, says "The drive X isn't plugged in: plug it in, or change the folder."; a plain
  folder under `/mnt` is this disk's. A stopped download carries on in the folder it began in (Resume isn't held by the
  folder chosen now). The page's every-second look at the folder (`folderLater`, the walk `modelFilesIn`) is asynchronous:
  one that takes over 1.5 s is answered with the last look, `pending`, and the page asks again.
- **The Hugging Face token** is the model pool's (secrets `HF_TOKEN`, `PUT /api/pool/hf-token`): it only goes to Hugging Face
  (not to its storage redirects), and is never sent back, logged or kept with a download.
- **Start and stop** (`hub/src/localRunners.ts`; web `views/LocalModelsLibrary.tsx`): `ollama serve` (`OLLAMA_HOST=127.0.0.1:<port>`;
  the program on the PATH, Homebrew's, or the one inside the Ollama app; `OLLAMA_NOPRUNE=1` while a pull is running or
  stopped, so it keeps the pull's part) and `llama-server -m <file> --host 127.0.0.1 --port <port> -c <context> -a <alias>
  -np 1` (Homebrew's, or the model pool's build), with `-ngl 999` on a Mac and on a PC whose GPUs hold the model (else
  llama.cpp splits it, the page's Slow), and `-c` never past the model's own context. A port is free only when it binds on
  127.0.0.1 and nothing answers at 127.0.0.1 or ::1 (a program on every address; test hubs, with
  `CROSSTALK_LOCAL_SERVER_PORTS` empty, only bind). Like the image editor: detached in
  its own process group (it outlives hub restarts on a Mac; under systemd it ends with the hub), a short environment,
  output in `run/local-servers/<kind>-<port>/server.log`, noted in `run/local-servers.json`. **Only those are stopped**: the
  hub's own child, or a noted process still alive and still running from its own folder, `run/local-servers/<id>` (a note
  pointing anywhere else, `..` included, proves nothing; one that doesn't hold up is forgotten, never signalled); Stop ends the process
  group (SIGTERM, then SIGKILL). Everything else says how to stop it where it runs (`LocalModelServer.stopWhy`); LM Studio
  "is managed in LM Studio". The scan for model servers also looks at the ports Crosstalk started servers on
  (`Services.extraPorts`). A start that fails says why (`explainExit` for llama.cpp, the log's last problem for Ollama);
  one that doesn't answer in time (10 minutes for llama.cpp, a minute for Ollama) is stopped; one that won't stop stays
  Crosstalk's (noted, with Stop) and says so.

## Routes (all for people's devices; types in the "0.5 Local models: downloads…" block of shared/src/protocol.ts)

| Route | Body / query | Answers |
|---|---|---|
| `GET /api/local-models/library` | | `LocalLibrary` (machine, folder, files, downloads, programs, started servers, hasHfToken, reserve, free ports) |
| `PUT /api/local-models/folder` | `{ path: string \| null }` | `LocalFolder` (400 for a bad path, 409 `folder` for one it can't use) |
| `GET /api/local-models/search?q=` | | `LocalSearchHit[]` |
| `GET /api/local-models/files?repo=` | a repo, link or file link | `LocalRepoFiles` (the pool's choices plus `kvBytesPerToken`, `contextLength`) |
| `GET /api/local-models/ollama?model=` | | `LocalOllamaInfo` (404 for an unknown name or an `hf.co/…` one) |
| `POST /api/local-models/downloads` | `LocalDownloadStart` | `LocalLibrary` (starts, or picks a stopped one up) |
| `POST /api/local-models/downloads/stop` | `{ id }` | `LocalLibrary` |
| `POST /api/local-models/downloads/remove` · `/files/remove` | `{ id, forGood? }` | `LocalLibrary` (409 `no_trash` when the drive's Trash can't be used, `busy` while the pool writes it or a Remove of it runs) |
| `POST /api/local-models/start` | `LocalServerStart` | `LocalLibrary` (409 `port_taken`, `no_program`) |
| `POST /api/local-models/stop` | `{ id }` | `LocalLibrary` (a failed start is put away; 404 for any server Crosstalk didn't start) |

`LocalModelServer` (GET /api/local-models) gains `startedId` and `stopWhy`; `LocalFolder` has `pending`, `LocalDownload` `note`.

## Tests and hooks

- Hub: `gguf.test.ts`, `local-library.test.ts`, `local-runners.test.ts`. Fakes: `fixtures/pool-fakes.ts` `fakeHuggingFace`
  (now with search and closed byte ranges), `fixtures/fake-local-models.ts` (Ollama's `/api/pull`, resumable), the new
  `fixtures/fake-ollama` program and `fixtures/gguf.ts` headers; the fake llama-server also reads its settings from
  `<its path>.json` (servers start with a short environment).
- Web: `localLibrary.test.ts` (the verdict and the words), `localModelsViews.test.tsx` (the parts drawn without a browser);
  browser `e2e/localModelsGet.spec.ts` (every answer played in the page).
- `CROSSTALK_LOCAL_PROGRAMS` (folders, ":" between; empty: nowhere) replaces where ollama and llama-server are looked for;
  in-memory hubs and `CROSSTALK_NO_AGENT_CLIS=1` look nowhere. `CROSSTALK_OLLAMA_REGISTRY` replaces Ollama's library
  (`https://registry.ollama.ai`); the browser test hub points it at a closed port.
