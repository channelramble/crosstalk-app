import { useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Check, ImagePlus, Minus, Plus } from "lucide-react";
import {
  ACCENT_SWATCHES,
  BACKGROUND_SWATCHES,
  CUSTOM_THEME,
  customFromPreset,
  DEFAULT_CUSTOM,
  DEFAULT_SETTINGS,
  GRADIENT_STARTS,
  gradientCss,
  hasSeeThrough,
  isPristine,
  paintFor,
  PRESET_GROUPS,
  PRESETS,
  presetById,
  previewVars,
  TEXTURES,
  type CustomBase,
  type CustomTheme,
  type Gradient,
  type GradientShape,
  type PictureFit,
  type TextChoice,
  type Texture,
  type ThemeSettings,
} from "../theme";
import { choosePicture, removePicture, resetTheme, setTheme, useDeviceLessGlass, usePictureUrl, useTheme } from "../themeDevice";
import { useStore } from "../store";
import { ConfirmButton, Switch } from "../ui";

/**
 * Settings → This device → Theme: the looks to pick from, each drawn small in its own colours and put on the moment
 * it's tapped; then your own (a colour, a gradient or a picture, with what panels look like over it), which changes the
 * app as each control moves; then the texture, which draws whatever theme is on as flat, as brushed metal or as glass.
 * Kept on this device only (themeDevice.ts).
 */
export function ThemeSection() {
  const theme = useTheme();
  const picture = usePictureUrl();
  const deviceCalm = useDeviceLessGlass();
  const set = (next: Partial<ThemeSettings>) => setTheme({ ...theme, ...next });
  const custom = theme.theme === CUSTOM_THEME;
  const changedCustom = JSON.stringify(theme.custom) !== JSON.stringify(DEFAULT_CUSTOM);
  const preset = presetById(theme.theme);
  const calmId = useId();
  const textureId = useId();
  // Your own theme's preview follows every control; it shows the look itself, see-through panels and all, whatever
  // "Reduce see-through effects" says.
  const ownPreview = useMemo(() => previewVars(paintFor({ ...DEFAULT_SETTINGS, theme: CUSTOM_THEME, custom: theme.custom }), picture), [theme.custom, picture]);
  return (
    <>
      <div className="card theme-card">
        <div className="help">How Crosstalk looks on this device. Your other devices keep their own look.</div>
        <div className="theme-tiles" role="radiogroup" aria-label="Theme" onKeyDown={arrowKeys}>
          {PRESET_GROUPS.map((group) => (
            <div className="theme-group" key={group}>
              <div className="theme-group-name">{group}</div>
              <div className="theme-grid">
                {PRESETS.filter((p) => p.group === group).map((p) => (
                  <Tile key={p.id} id={p.id} name={p.name} about={p.about} on={theme.theme === p.id} vars={presetPreview(p.id)} onPick={() => set({ theme: p.id })} />
                ))}
              </div>
            </div>
          ))}
          <div className="theme-group">
            <div className="theme-group-name">Yours</div>
            <div className="theme-grid">
              <Tile id={CUSTOM_THEME} name="Your own" about="Your colours, a gradient or a picture." on={custom} vars={ownPreview} onPick={() => set({ theme: CUSTOM_THEME })} />
            </div>
          </div>
        </div>
        {!custom && preset && (
          <div className="theme-from">
            <span className="help">Want to change {preset.name}? Make it the start of your own theme.</span>
            {changedCustom ? (
              <ConfirmButton
                className="btn small"
                label="Change this theme"
                question="This replaces your own theme's colours."
                confirmLabel="Replace"
                onConfirm={() => set({ theme: CUSTOM_THEME, custom: customFromPreset(preset.id, theme.custom) })}
              />
            ) : (
              <button type="button" className="btn small" onClick={() => set({ theme: CUSTOM_THEME, custom: customFromPreset(preset.id, theme.custom) })}>
                Change this theme
              </button>
            )}
          </div>
        )}
      </div>

      {custom && <CustomEditor theme={theme} picture={picture} />}

      <section className="card texture-card" aria-labelledby={textureId}>
        <h3 id={textureId}>Texture</h3>
        <div className="help">How bars, buttons and panels are drawn. It works with every theme and changes none of its colours.</div>
        <div className="texture-grid" role="radiogroup" aria-label="Texture" onKeyDown={arrowKeys}>
          {TEXTURES.map((t) => (
            <TextureTile key={t.id} id={t.id} name={t.name} about={t.about} on={theme.texture === t.id} onPick={() => set({ texture: t.id })} />
          ))}
        </div>
      </section>

      <section className="card" aria-label="Reduce see-through effects">
        <div className="row">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>Reduce see-through effects</div>
            <div className="help" id={calmId}>
              {deviceCalm
                ? "This device already asks for less see-through, so panels are solid and nothing blurs."
                : hasSeeThrough(theme)
                  ? "Makes panels solid and turns blur off. Easier to read, and lighter work for an older phone."
                  : "Makes panels solid and turns blur off in themes with a gradient or a picture, and with the Liquid glass texture. Nothing is see-through as things are."}
            </div>
          </div>
          <Switch checked={theme.calm || deviceCalm} disabled={deviceCalm} onChange={(calm) => set({ calm })} label="Reduce see-through effects" describedBy={calmId} />
        </div>
      </section>

      <div className="theme-reset">
        <ConfirmButton
          className="btn small"
          label="Reset theme"
          question="Back to OLED black and the Flat texture, and your own theme and picture are removed from this device."
          confirmLabel="Reset"
          disabled={isPristine(theme)}
          onConfirm={() => void resetTheme()}
        />
      </div>
    </>
  );
}

/** Each preset's preview colours, worked out once: they never change. */
const previews = new Map<string, Record<string, string>>();
function presetPreview(id: string): Record<string, string> {
  let vars = previews.get(id);
  if (!vars) previews.set(id, (vars = previewVars(paintFor({ ...DEFAULT_SETTINGS, theme: id }))));
  return vars;
}

/** One look, drawn small in its own colours. */
function Tile({ id, name, about, on, vars, onPick }: { id: string; name: string; about: string; on: boolean; vars: Record<string, string>; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={`${name}. ${about}`} title={about} className={`theme-tile${on ? " on" : ""}`} onClick={onPick} data-theme-tile={id}>
      <Preview vars={vars} />
      {on && (
        <span className="theme-tile-check" aria-hidden="true">
          <Check size={12} strokeWidth={3.2} />
        </span>
      )}
      <span className="theme-tile-name">{name}</span>
    </button>
  );
}

/**
 * The arrow keys in a group of tiles: to the next or the one before (round the ends), Home and End to the first and
 * the last, picking it as a group of radio buttons does. Tab still reaches every tile.
 */
function arrowKeys(e: KeyboardEvent<HTMLElement>) {
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step && e.key !== "Home" && e.key !== "End") return;
  const tiles = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = tiles.indexOf(e.target as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const next = tiles[e.key === "Home" ? 0 : e.key === "End" ? tiles.length - 1 : (at + step + tiles.length) % tiles.length];
  next.focus();
  next.click();
}

/** One texture: a bit of bar, a button and a switch drawn its way in the colours of the theme in use, and a line about it. */
function TextureTile({ id, name, about, on, onPick }: { id: Texture; name: string; about: string; on: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={`${name}. ${about}`} className={`theme-tile texture-tile${on ? " on" : ""}`} onClick={onPick} data-texture-tile={id}>
      <span className={`xp xp-${id}`} aria-hidden="true">
        <span className="xp-bar">
          <i className="xp-dot" />
          <i className="xp-line" />
        </span>
        <span className="xp-row">
          <i className="xp-btn" />
          <i className="xp-key" />
          <i className="xp-switch" />
        </span>
      </span>
      {on && (
        <span className="theme-tile-check" aria-hidden="true">
          <Check size={12} strokeWidth={3.2} />
        </span>
      )}
      <span className="texture-tile-text">
        <span className="theme-tile-name">{name}</span>
        <span className="texture-tile-about">{about}</span>
      </span>
    </button>
  );
}

/** A chat in miniature: its top bar, a reply with a link in it, your message and the message box. */
function Preview({ vars }: { vars: Record<string, string> }) {
  return (
    <span className="tp" style={vars as CSSProperties} aria-hidden="true">
      <span className="tp-bar">
        <i className="tp-dot" />
        <i className="tp-line" />
      </span>
      <span className="tp-reply">
        <i />
        <i />
        <i />
      </span>
      <span className="tp-you" />
      <span className="tp-box">
        <i className="tp-line" />
        <i className="tp-send" />
      </span>
    </span>
  );
}

/** A slider with its name and what it's at. Arrow keys move it, as any range input. */
function Range({ label, value, min, max, step = 1, says, ends, onChange }: { label: string; value: number; min: number; max: number; step?: number; says: (n: number) => string; ends?: [string, string]; onChange: (n: number) => void }) {
  const id = useId();
  return (
    <div className="theme-range">
      <div className="theme-range-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{says(value)}</output>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={says(value)} style={{ ["--fill" as string]: (value - min) / (max - min || 1) }} onChange={(e) => onChange(Number(e.target.value))} />
      {ends && (
        <div className="theme-range-ends" aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  );
}

/** A choice of a few, side by side, each a full-height tap. */
function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg theme-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A colour: good ones to tap, and the browser's own picker for any other. */
function ColorField({ label, value, swatches, onChange }: { label: string; value: string; swatches?: string[]; onChange: (hex: string) => void }) {
  const listed = swatches?.some((s) => s.toLowerCase() === value.toLowerCase());
  return (
    <div className="theme-field" role="group" aria-label={label}>
      <div className="theme-label">{label}</div>
      <div className="theme-swatches">
        {swatches?.map((s) => (
          <button key={s} type="button" className={`theme-swatch${s.toLowerCase() === value.toLowerCase() ? " on" : ""}`} aria-label={`${label} ${s}`} aria-pressed={s.toLowerCase() === value.toLowerCase()} onClick={() => onChange(s)}>
            <i style={{ background: s }} />
          </button>
        ))}
        <label className={`theme-swatch any${swatches && !listed ? " on" : ""}`} title="Any colour">
          <i style={swatches && listed ? undefined : { background: value }} />
          <input type="color" value={value} aria-label={`${label}: any colour`} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

const BASES: { id: CustomBase; label: string }[] = [
  { id: "color", label: "Colour" },
  { id: "gradient", label: "Gradient" },
  { id: "picture", label: "Picture" },
];
const SHAPES: { id: GradientShape; label: string }[] = [
  { id: "linear", label: "Straight" },
  { id: "radial", label: "Round" },
];
const FITS: { id: PictureFit; label: string }[] = [
  { id: "fill", label: "Fill the screen" },
  { id: "fit", label: "Show all of it" },
];
const WORDS: { id: TextChoice; label: string }[] = [
  { id: "auto", label: "Automatic" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];
const percent = (n: number) => `${Math.round(n)}%`;
const pixels = (n: number) => (n ? `${Math.round(n)} px` : "Off");

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="theme-part" aria-label={title}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Your own theme: every control changes the app as it moves. */
function CustomEditor({ theme, picture }: { theme: ThemeSettings; picture: string | null }) {
  const toast = useStore((s) => s.toast);
  const c = theme.custom;
  const change = (next: Partial<CustomTheme>) => setTheme({ ...theme, custom: { ...c, ...next } });
  const gradient = (next: Partial<Gradient>) => change({ gradient: { ...c.gradient, ...next } });
  const pic = (next: Partial<CustomTheme["picture"]>) => change({ picture: { ...c.picture, ...next } });
  const file = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setReading(true);
    try {
      await choosePicture(f);
    } catch (e) {
      toast("error", e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
      if (file.current) file.current.value = "";
    }
  };
  const hasPicture = !!c.picture.average;
  const overBackdrop = c.base === "gradient" || (c.base === "picture" && hasPicture);
  return (
    <section className="card theme-editor" aria-label="Your own theme">
      <div style={{ fontWeight: 600 }}>Your own theme</div>
      <div className="help">Everything here changes the app as you move it.</div>

      <Part title="Background">
        <Pick label="Background" value={c.base} options={BASES} onChange={(base) => change({ base })} />

        {c.base === "color" && (
          <>
            <ColorField label="Background colour" value={c.background} swatches={BACKGROUND_SWATCHES} onChange={(background) => change({ background })} />
            <div className="help">A colour in the middle, neither dark nor light, is made a little darker or lighter so words read on it.</div>
          </>
        )}

        {c.base === "gradient" && (
          <>
            <div className="theme-field" role="group" aria-label="Start from">
              <div className="theme-label">Start from</div>
              <div className="theme-starts">
                {GRADIENT_STARTS.map((g) => {
                  const on = JSON.stringify(g.gradient) === JSON.stringify(c.gradient);
                  return (
                    <button key={g.name} type="button" className={`theme-start${on ? " on" : ""}`} aria-pressed={on} onClick={() => gradient({ ...g.gradient, stops: [...g.gradient.stops] })}>
                      <i style={{ background: gradientCss(g.gradient) }} />
                      <span>{g.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="theme-field" role="group" aria-label="Gradient colours">
              <div className="theme-label">Colours</div>
              <div className="theme-swatches">
                {c.gradient.stops.map((s, i) => (
                  <label key={i} className="theme-swatch stop" title={`Colour ${i + 1}`}>
                    <i style={{ background: s }} />
                    <input type="color" value={s} aria-label={`Gradient colour ${i + 1}`} onChange={(e) => gradient({ stops: c.gradient.stops.map((x, k) => (k === i ? e.target.value : x)) })} />
                  </label>
                ))}
                {c.gradient.stops.length < 3 ? (
                  <button type="button" className="theme-swatch add" aria-label="Add a colour" title="Add a colour" onClick={() => gradient({ stops: [...c.gradient.stops, c.gradient.stops[c.gradient.stops.length - 1]] })}>
                    <Plus size={18} aria-hidden />
                  </button>
                ) : (
                  <button type="button" className="theme-swatch add" aria-label="Remove the last colour" title="Remove the last colour" onClick={() => gradient({ stops: c.gradient.stops.slice(0, 2) })}>
                    <Minus size={18} aria-hidden />
                  </button>
                )}
              </div>
            </div>
            <div className="theme-field">
              <div className="theme-label">Shape</div>
              <Pick label="Gradient shape" value={c.gradient.shape} options={SHAPES} onChange={(shape) => gradient({ shape })} />
            </div>
            {c.gradient.shape === "linear" && <Range label="Direction" value={c.gradient.angle} min={0} max={360} step={5} says={(n) => `${Math.round(n)}°`} onChange={(angle) => gradient({ angle })} />}
            <div className="help">Bright colours are dimmed just enough for words to read on them.</div>
          </>
        )}

        {c.base === "picture" && (
          <>
            {/* Not drawn: the buttons below open it. */}
            <input ref={file} type="file" accept="image/*" hidden aria-label="Choose a picture" onChange={(e) => void pickFile(e.target.files?.[0])} />
            {hasPicture ? (
              <>
                <div className="theme-picture">
                  <span className="theme-picture-thumb" style={{ backgroundColor: c.picture.average ?? undefined, backgroundImage: picture ? `url("${picture}")` : undefined }} role="img" aria-label="Your picture" />
                  <div className="theme-picture-actions">
                    <button type="button" className="btn" onClick={() => file.current?.click()} disabled={reading}>
                      {reading ? "Reading…" : "Change picture"}
                    </button>
                    <ConfirmButton className="btn ghost danger" label="Remove picture" question="Remove it from this device?" confirmLabel="Remove" onConfirm={() => void removePicture()} />
                  </div>
                </div>
                <Range label="Blur" value={c.picture.blur} min={0} max={40} says={pixels} ends={["Sharp", "Soft"]} onChange={(blur) => pic({ blur })} />
                <Range label="Dim" value={c.picture.dim} min={0} max={100} says={percent} ends={["As bright as reads well", "Barely there"]} onChange={(dim) => pic({ dim })} />
                <div className="theme-field">
                  <div className="theme-label">How it sits</div>
                  <Pick label="How the picture sits" value={c.picture.fit} options={FITS} onChange={(fit) => pic({ fit })} />
                </div>
                <Range label="Left to right" value={c.picture.x} min={0} max={100} says={percent} onChange={(x) => pic({ x })} />
                <Range label="Top to bottom" value={c.picture.y} min={0} max={100} says={percent} onChange={(y) => pic({ y })} />
              </>
            ) : (
              <button type="button" className="theme-choose" onClick={() => file.current?.click()} disabled={reading}>
                <ImagePlus size={22} aria-hidden />
                <span>{reading ? "Reading…" : "Choose a picture"}</span>
                <span className="help">It's made smaller and kept on this device only. Until you choose one, your background colour shows.</span>
              </button>
            )}
          </>
        )}
      </Part>

      <Part title="Accent">
        <ColorField label="Accent colour" value={c.accent} swatches={ACCENT_SWATCHES} onChange={(accent) => change({ accent })} />
        <div className="help">Links, what's selected and what's switched on. It's made lighter or darker when it wouldn't read on your background.</div>
      </Part>

      <Part title="Panels">
        {overBackdrop ? (
          <>
            <Range label="See-through" value={c.seeThrough} min={0} max={100} step={5} says={percent} ends={["Solid", "Glass"]} onChange={(seeThrough) => change({ seeThrough })} />
            <Range label="Blur behind panels" value={c.panelBlur} min={0} max={40} step={2} says={pixels} onChange={(panelBlur) => change({ panelBlur })} />
            {theme.texture === "glass" && <div className="help">With the Liquid glass texture, bars and sheets are always see-through, and the blur is at least 28 px.</div>}
          </>
        ) : (
          <div className="help">Over a gradient or a picture, panels can be see-through.</div>
        )}
        <Range label="Corners" value={c.round} min={0} max={100} step={5} says={(n) => (n === 50 ? "As designed" : n < 50 ? "Squarer" : "Rounder")} ends={["Square", "Round"]} onChange={(round) => change({ round })} />
      </Part>

      <Part title="Words">
        <Pick label="Words" value={c.text} options={WORDS} onChange={(text) => change({ text })} />
        <div className="help">Automatic picks light or dark words, whichever reads better on your background. Choosing one yourself dims or lightens the background until it reads.</div>
      </Part>

      <div className="theme-editor-foot">
        <ConfirmButton
          className="btn small"
          label="Start again"
          question="Your own theme goes back to how it started. Your picture stays."
          confirmLabel="Start again"
          disabled={JSON.stringify({ ...c, picture: null }) === JSON.stringify({ ...DEFAULT_CUSTOM, picture: null })}
          onConfirm={() => change({ ...DEFAULT_CUSTOM, picture: { ...DEFAULT_CUSTOM.picture, average: c.picture.average, lo: c.picture.lo, hi: c.picture.hi } })}
        />
      </div>
    </section>
  );
}
