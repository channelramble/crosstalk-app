// Settings → Templates (anchor #templates): the machine's ways to start a chat (hub templates.ts). Add one, edit it, rename it,
// move it up or down, or delete it (asked twice). Each machine keeps its own: with several, this is the machine Settings shows,
// and says so. New chat → From a template lists them all (TemplatePick.tsx).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Ellipsis, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { CHAT_PROVIDERS, PROVIDER_INFO, TEMPLATE_NAME_MAX, TEMPLATE_STARTERS, TEMPLATE_TEXT_MAX, type ChatProvider, type PromptTemplate, type TemplateInput } from "@crosstalk/shared";
import { TemplateError, addTemplate, deleteTemplate, moveTemplate, restoreStarters, saveTemplate, templateFailed, type TemplateMachine } from "../templateApi";
import { blanksIn, changedInput, olderHub, recentFolders, templateLine, templatePreview } from "../templates";
import { useMachines, useStore } from "../store";
import { AskTwiceDialog, Dialog, useAutosize } from "../ui";
import { AgentOptions, type AgentChoice } from "./AgentOptions";
import { useMachineName } from "./MachinePicker";
import { TipHeading } from "./Tip";
import { FolderPicker, NEW_FOLDER, OTHER_FOLDER } from "./FolderPicker";



type Control = "more" | "up" | "down";

/** Why a save didn't happen, with the way on: the hub's refusals say what to change; a machine out of reach is tried again. */
function saveError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  if (e instanceof TemplateError && e.why === "down") return `${text} Tap Save to try again.`;
  if (e instanceof TemplateError && e.code === "no_template") return `${text} Tap Cancel to close this.`;
  return text;
}

/** The machine Settings shows, as its templates' requests need it. */
function useTarget(): TemplateMachine | null {
  const key = useStore((s) => s.active);
  const conn = useStore((s) => s.conn);
  const name = useMachineName();
  return useMemo(() => (conn ? { key, name, conn } : null), [key, name, conn]);
}

export function TemplatesSection() {
  const templates = useStore((s) => s.templates);
  const loaded = useStore((s) => s.loadedAt !== null);
  const several = useMachines((m) => m.list.length > 1);
  const target = useTarget();
  const machine = useMachineName();
  return <TemplatesList templates={templates} loaded={loaded} machine={machine} several={several} target={target} />;
}

/**
 * The section as shown, for the machine TemplatesSection gives it: its templates (null until they've come, and from a machine
 * before templates once its state has come: `loaded`).
 */
export function TemplatesList({ templates, loaded, machine, several, target }: { templates: PromptTemplate[] | null; loaded: boolean; machine: string; several: boolean; target: TemplateMachine | null }) {
  const [editing, setEditing] = useState<PromptTemplate | "new" | null>(null);
  const [renaming, setRenaming] = useState<PromptTemplate | null>(null);
  const [deleting, setDeleting] = useState<PromptTemplate | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  // Where focus goes once a move is on screen: React may have moved the row, and focus with it is lost.
  const refocus = useRef<{ id: string; controls: Control[] } | null>(null);
  useLayoutEffect(() => {
    const want = refocus.current;
    if (!want || busy) return;
    refocus.current = null;
    const row = [...document.querySelectorAll<HTMLElement>("[data-template]")].find((el) => el.dataset.template === want.id);
    want.controls.map((c) => row?.querySelector<HTMLElement>(`[data-template-control="${c}"]`)).find(Boolean)?.focus();
  });
  // Where focus goes once a Rename or Delete for a row has closed: its ⋯ tray went as the dialog opened (and a deleted row
  // goes with it), so the dialog has nowhere to give focus back. That row's ⋯, or once it's deleted the next one's (Add a
  // template when none is left). An effect, so it comes after the dialog's own; never while a dialog is still open.
  const back = useRef<{ id: string; index: number } | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const want = back.current;
    if (!want || renaming || deleting) return;
    back.current = null;
    if (document.querySelector('[role="dialog"]')) return;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-template]")];
    const row = rows.find((el) => el.dataset.template === want.id) ?? rows[Math.min(want.index, rows.length - 1)];
    (row?.querySelector<HTMLElement>('[data-template-control="more"]') ?? add.current)?.focus();
  });
  const askDelete = (t: PromptTemplate) => {
    back.current = { id: t.id, index: templates?.findIndex((x) => x.id === t.id) ?? 0 };
    setDeleting(t);
  };
  // A machine from before templates says so once its state is in (a list that hasn't come yet is still loading).
  const older = templates === null && loaded;
  const missing = TEMPLATE_STARTERS.filter((k) => !templates?.some((t) => t.starter === k)).length;

  /** One change at a time; a failed one says why (Try now when the machine is out of reach). */
  const run = async (work: () => Promise<unknown>, after?: { id: string; controls: Control[] }) => {
    if (running.current || !target) return;
    running.current = true;
    setBusy(true);
    try {
      await work();
      if (after) refocus.current = after;
    } catch (e) {
      templateFailed(e);
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-label="Templates">
      <TipHeading id="templates" topic="templates">Templates</TipHeading>
      <p className="help tpl-intro">
        Start a chat from one in New chat. Put a few words in {"{curly brackets}"} for a blank you fill in each time.
        {several && ` These are on ${machine}: each machine keeps its own.`}
      </p>
      {older ? (
        <div className="card tpl-note" role="note">
          <p className="small">{olderHub(machine)}</p>
          <button type="button" className="btn small" onClick={() => void useStore.getState().refresh().catch(() => {})}>
            Check again
          </button>
        </div>
      ) : templates === null ? (
        <p className="muted small">Loading templates…</p>
      ) : (
        <>
          <button ref={add} type="button" className="btn primary block" onClick={() => setEditing("new")}>
            <Plus size={16} /> Add a template
          </button>
          {templates.length === 0 ? (
            <p className="muted small tpl-empty">No templates on {machine} yet.</p>
          ) : (
            <ul className="list-group tpl-list" aria-label={`Templates on ${machine}`}>
              {templates.map((t, i) => (
                <TemplateRow
                  key={t.id}
                  template={t}
                  place={{ index: i, count: templates.length }}
                  open={open === t.id}
                  busy={busy}
                  onOpen={(v) => setOpen(v ? t.id : null)}
                  onEdit={() => setEditing(t)}
                  onRename={() => {
                    back.current = { id: t.id, index: i };
                    setOpen(null);
                    setRenaming(t);
                  }}
                  onDelete={() => {
                    setOpen(null);
                    askDelete(t);
                  }}
                  // The tray stays open, on the same button when it's still there.
                  onMove={(to) => void run(() => moveTemplate(target!, t.id, to), { id: t.id, controls: to < i ? ["up", "down", "more"] : ["down", "up", "more"] })}
                />
              ))}
            </ul>
          )}
          {missing > 0 && (
            <button type="button" className="link-btn tpl-starters" disabled={busy} onClick={() => void run(() => restoreStarters(target!))}>
              {missing === TEMPLATE_STARTERS.length ? "Add the starter templates" : missing === 1 ? "Add the deleted starter template back" : "Add the deleted starter templates back"}
            </button>
          )}
        </>
      )}
      {editing && target && <TemplateEditor machine={target} template={editing === "new" ? null : editing} onDelete={askDelete} onClose={() => setEditing(null)} />}
      {renaming && target && <RenameDialog machine={target} template={renaming} onClose={() => setRenaming(null)} />}
      {deleting && target && (
        <AskTwiceDialog
          title={`Delete "${deleting.name}"?`}
          icon={<Trash2 size={18} />}
          sure="This can't be undone."
          confirmLabel="Yes, delete"
          workingLabel="Deleting…"
          onConfirm={async () => {
            await deleteTemplate(target, deleting.id);
            // It was open to edit: that goes with it.
            setEditing((e) => (e !== "new" && e?.id === deleting.id ? null : e));
          }}
          onClose={() => setDeleting(null)}
        >
          <p className="small" style={{ margin: 0 }}>
            It's removed from every device. Chats you started from it stay.
            {deleting.starter && " You can add the starters back later."}
          </p>
        </AskTwiceDialog>
      )}
    </section>
  );
}

/** A template's row: its name, what it sets and how it starts, Edit, and a ⋯ for its options (move, rename, delete). */
function TemplateRow({ template: t, place, open, busy, onOpen, onEdit, onRename, onDelete, onMove }: { template: PromptTemplate; place: { index: number; count: number }; open: boolean; busy: boolean; onOpen: (open: boolean) => void; onEdit: () => void; onRename: () => void; onDelete: () => void; onMove: (to: number) => void }) {
  const item = useRef<HTMLLIElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const tray = `tpl-tray-${t.id}`;
  const close = useRef(onOpen);
  close.current = onOpen;
  // The tray closes on a tap anywhere else, or Escape (back on the ⋯ button).
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!item.current?.contains(e.target as Node)) close.current(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      close.current(false);
      more.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  // aria-disabled, not disabled: a disabled button would lose focus while its move is on its way.
  const button = (control: Control | null, icon: ReactNode, label: string, act: () => void, danger = false) => (
    <button type="button" className={`tpl-tray-btn ${danger ? "danger" : ""}`} data-template-control={control ?? undefined} aria-disabled={busy || undefined} onClick={() => !busy && act()}>
      {icon}
      {label}
    </button>
  );
  return (
    <li ref={item} className={`tpl-item ${open ? "open" : ""}`} data-template={t.id}>
      <div className="tpl-row">
        <div className="tpl-text">
          <div className="tpl-name">{t.name}</div>
          <div className="tpl-line">{templateLine(t)}</div>
          <div className="tpl-preview">{templatePreview(t.text)}</div>
        </div>
        <div className="tpl-actions">
          <button type="button" className="btn small" onClick={onEdit} aria-label={`Edit ${t.name}`}>
            <Pencil size={13} aria-hidden="true" /> Edit
          </button>
          <button ref={more} type="button" className="icon-btn tpl-more" data-template-control="more" aria-label={`Options for ${t.name}`} title="Options" aria-expanded={open} aria-controls={open ? tray : undefined} onClick={() => onOpen(!open)}>
            <Ellipsis size={17} />
          </button>
        </div>
      </div>
      {open && (
        <div id={tray} className="tpl-tray" role="group" aria-label={`Options for ${t.name}`}>
          {place.count > 1 && (
            <span className="tpl-place" aria-live="polite">
              {place.index + 1} of {place.count}
            </span>
          )}
          {place.index > 0 && button("up", <ArrowUp size={15} aria-hidden="true" />, "Move up", () => onMove(place.index - 1))}
          {place.index < place.count - 1 && button("down", <ArrowDown size={15} aria-hidden="true" />, "Move down", () => onMove(place.index + 1))}
          {button(null, <Pencil size={15} aria-hidden="true" />, "Rename", onRename)}
          {button(null, <Trash2 size={15} aria-hidden="true" />, "Delete", onDelete, true)}
        </div>
      )}
    </li>
  );
}

/** What the editor holds, as it compares to what was saved. */
interface Form {
  name: string;
  text: string;
  agent: ChatProvider | "";
  choice: AgentChoice;
  folder: string;
  path: string;
}

const noChoice = (): AgentChoice => ({ account: "default", model: "", effort: "", permissionMode: "ask" });

/** `hasAccount`: whether this machine has that account for that agent (one removed since shows as the main sign-in). */
function formOf(t: PromptTemplate | null, folders: string[], hasAccount: (agent: ChatProvider, id: string) => boolean): Form {
  const folder = !t?.folder ? NEW_FOLDER : folders.includes(t.folder) ? t.folder : OTHER_FOLDER;
  return {
    name: t?.name ?? "",
    text: t?.text ?? "",
    agent: t?.agent ?? "",
    choice: { ...noChoice(), account: t?.agent && t.account && hasAccount(t.agent, t.account) ? t.account : "default", model: t?.model ?? "", effort: t?.effort ?? "" },
    folder,
    path: folder === OTHER_FOLDER ? (t?.folder ?? "") : "",
  };
}

/** A template as the hub keeps it, in the form a save gives (what the editor's save is compared with: templates.ts changedInput). */
const savedOf = (t: PromptTemplate): TemplateInput => ({ name: t.name, text: t.text, agent: t.agent, account: t.account, model: t.model, effort: t.effort, folder: t.folder });

/** What the hub keeps of the form. */
function inputOf(f: Form): TemplateInput {
  return {
    name: f.name.trim(),
    text: f.text,
    agent: f.agent || null,
    account: f.agent && f.choice.account !== "default" ? f.choice.account : null,
    model: f.agent ? f.choice.model.trim() || null : null,
    effort: f.agent ? f.choice.effort.trim() || null : null,
    folder: f.folder === NEW_FOLDER ? null : f.folder === OTHER_FOLDER ? f.path.trim() || null : f.folder,
  };
}

/**
 * Adds a template (`template` null) or edits one: its name, first message, agent, model, effort and folder. An edit saves
 * only what it changed, so what another device changed meanwhile stays.
 */
function TemplateEditor({ machine, template, onDelete, onClose }: { machine: TemplateMachine; template: PromptTemplate | null; onDelete: (t: PromptTemplate) => void; onClose: () => void }) {
  const rooms = useStore((s) => s.rooms);
  const accounts = useStore((s) => s.accounts);
  const folders = useMemo(() => recentFolders(Object.values(rooms)), [rooms]);
  const hasAccount = (agent: ChatProvider, id: string) => Object.values(accounts).some((a) => a.provider === agent && a.id === id);
  // With the template's own folder among them when it's one of this machine's chats'.
  const [start] = useState(() => formOf(template, folders, hasAccount));
  // Its account was removed from this machine since: it's on the main sign-in now, and saved so (the account can't be picked).
  const [accountGone] = useState(() => !!template?.agent && !!template.account && !hasAccount(template.agent, template.account));
  const [form, setForm] = useState(start);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  useAutosize(text, form.text);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const dirty = JSON.stringify(inputOf(form)) !== JSON.stringify(inputOf(start));
  const blanks = blanksIn(form.text);
  const shownFolders = form.folder !== NEW_FOLDER && form.folder !== OTHER_FOLDER && !folders.includes(form.folder) ? [form.folder, ...folders] : folders;
  const canSave = !saving && !!form.name.trim() && !!form.text.trim() && !(form.folder === OTHER_FOLDER && !form.path.trim());
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      if (template) await saveTemplate(machine, template.id, changedInput(savedOf(template), inputOf(form)));
      else await addTemplate(machine, inputOf(form));
      onClose();
    } catch (e) {
      setError(saveError(e));
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={template ? "Edit template" : "New template"}
      icon={<FileText size={18} />}
      dirty={dirty && !saving}
      onClose={() => !saving && onClose()}
      footer={(requestClose) => (
        <>
          <button type="button" className="btn" disabled={saving} onClick={() => requestClose()}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSave} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      )}
    >
      <label className="field">
        <span>Name</span>
        <input className="input" aria-label="Name" value={form.name} maxLength={TEMPLATE_NAME_MAX} placeholder="Fix a bug" autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>First message</span>
        <textarea
          ref={text}
          className="textarea tpl-message"
          aria-label="First message"
          aria-describedby="tpl-message-help"
          value={form.text}
          maxLength={TEMPLATE_TEXT_MAX}
          rows={4}
          placeholder="Explain how {part of the app} works, in plain words."
          onChange={(e) => set({ text: e.target.value })}
        />
        <span className="help" id="tpl-message-help">
          {blanks.length
            ? `Blanks you fill in each time: ${blanks.join(", ")}.`
            : "Sent when the chat starts. Put a few words in {curly brackets} for a blank you fill in each time, like {file}."}
        </span>
      </label>
      <label className="field">
        <span>Agent</span>
        <select className="select" aria-label="Agent" value={form.agent} onChange={(e) => set({ agent: e.target.value as ChatProvider | "", choice: noChoice() })}>
          <option value="">Any agent</option>
          {CHAT_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_INFO[p].name}
            </option>
          ))}
        </select>
        <span className="help">{form.agent ? "Model and effort left on Your default are what New chat picks." : "The one you open New chat for."}</span>
        {accountGone && form.agent === template?.agent && form.choice.account === "default" && (
          <span className="help">The account it had isn't on this machine anymore, so it's set to {Object.values(accounts).find((a) => a.provider === form.agent && a.id === "default")?.label ?? "Main"}.</span>
        )}
      </label>
      {form.agent && <AgentOptions key={form.agent} provider={form.agent} value={form.choice} onChange={(choice) => set({ choice })} showPermissions={false} showHelpers={false} connection={machine.conn} unset="Your default" />}
      <FolderPicker
        folder={form.folder}
        path={form.path}
        onPick={(f, typed) => set({ folder: f, ...(typed !== undefined ? { path: typed } : {}) })}
        known={shownFolders}
        conn={machine.conn}
        newHelp="A new empty folder, unless you pick one when you start."
        pickedHelp={`Chats from it work in this folder on ${machine.name}.`}
      />
      {error && (
        <p role="alert" className="small" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
      {template && (
        <button type="button" className="btn small ghost danger tpl-delete" disabled={saving} onClick={() => onDelete(template)}>
          <Trash2 size={13} aria-hidden="true" /> Delete template
        </button>
      )}
    </Dialog>
  );
}

/** A new name for a template, and only that. */
function RenameDialog({ machine, template, onClose }: { machine: TemplateMachine; template: PromptTemplate; onClose: () => void }) {
  const field = useRef<HTMLInputElement>(null);
  // In the name, all of it picked, ready to type over (after the dialog has taken focus itself).
  useEffect(() => field.current?.select(), []);
  const [name, setName] = useState(template.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const named = name.replace(/\s+/g, " ").trim();
  const canSave = !saving && !!named && named !== template.name;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await saveTemplate(machine, template.id, { name: named });
      onClose();
    } catch (e) {
      setError(saveError(e));
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="Rename template"
      icon={<Pencil size={18} />}
      onClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!canSave} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input
          ref={field}
          className="input"
          aria-label="Name"
          value={name}
          maxLength={TEMPLATE_NAME_MAX}
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => setName(e.target.value)}
          // Enter saves (not while a keyboard is still putting a word together).
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void save();
          }}
        />
      </label>
      {error && (
        <p role="alert" className="small" style={{ color: "var(--red)" }}>
          {error}
        </p>
      )}
    </Dialog>
  );
}
