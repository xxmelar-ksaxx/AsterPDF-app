import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Pipette } from 'lucide-react';

function toHsv(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: hue * 60, s: max ? delta / max : 0, v: max };
}
function toHex({ h, s, v }: ReturnType<typeof toHsv>) {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}
type EyeDropperConstructor = new () => { open(): Promise<{ sRGBHex: string }> };

export default function ColorPicker({ value, recent, onChange }: {
  value: string; recent: string[]; onChange: (value: string, remember?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState(() => toHsv(value));
  const [hex, setHex] = useState(value);
  const [error, setError] = useState('');
  const [sampling, setSampling] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const latest = useRef(value);
  const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper;
  useEffect(() => {
    if (value !== latest.current) setHsv(toHsv(value));
    latest.current = value; setHex(value);
  }, [value]);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 272)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 340)) });
    };
    const outside = (event: globalThis.PointerEvent) => {
      if (!sampling && !menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, sampling]);
  const choose = (color: string, remember = true) => {
    const normalized = color.toLowerCase();
    latest.current = normalized; setHex(normalized); setHsv(toHsv(normalized)); setError(''); onChange(normalized, remember);
  };
  const adjust = (next: typeof hsv) => {
    const color = toHex(next);
    latest.current = color; setHsv(next); setHex(color); setError(''); onChange(color, false);
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    adjust({ ...hsv, s: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      v: 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) });
  };
  const commitHex = () => {
    const normalized = hex.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(normalized)) choose(`#${normalized}`);
    else if (/^[0-9a-f]{3}$/i.test(normalized)) choose('#' + [...normalized].map((part) => part + part).join(''));
    else setError('Enter a hex color, such as #172333.');
  };
  const sample = async () => {
    if (!EyeDropper) return;
    setSampling(true); setError('');
    try { choose((await new EyeDropper().open()).sRGBHex); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError('Could not pick a screen color. Try again.'); }
    finally { setSampling(false); }
  };
  return <div className="color-picker" data-added-text-controls>
    <button ref={trigger} className="color-picker-trigger" aria-label="Text and drawing color" title={`Color ${value}`}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(!open); setError(''); }}>
      <span style={{ background: value }} />
    </button>
    {open && createPortal(<div ref={menu} className="color-picker-menu" style={position} role="dialog" aria-label="Choose color"
      data-added-text-controls onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      }}>
      <h3>Recent colors</h3>
      <div className="recent-color-grid">
        {recent.slice(0, 10).map((color) => <button key={color} className={`color-swatch${color === value ? ' active' : ''}`}
          style={{ background: color }} aria-label={`Recent color ${color}`} title={color} onClick={() => choose(color)} />)}
        {!recent.length && <p>Colors you use will appear here.</p>}
      </div>
      <h3>Custom color</h3>
      <div className="color-spectrum" style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }} tabIndex={0}
        role="slider" aria-label="Saturation and brightness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
        onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); point(event); }}
        onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) point(event); }}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.currentTarget.releasePointerCapture(event.pointerId); onChange(latest.current, true); } }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          adjust({ ...hsv, s: Math.max(0, Math.min(1, hsv.s + (event.key === 'ArrowRight' ? .01 : event.key === 'ArrowLeft' ? -.01 : 0))),
            v: Math.max(0, Math.min(1, hsv.v + (event.key === 'ArrowUp' ? .01 : event.key === 'ArrowDown' ? -.01 : 0))) });
        }} onKeyUp={(event) => { if (event.key.startsWith('Arrow')) onChange(latest.current, true); }}>
        <span style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input className="color-hue" type="range" min="0" max="359" aria-label="Hue" value={hsv.h}
        onChange={(event) => adjust({ ...hsv, h: Number(event.target.value) })}
        onPointerUp={() => onChange(latest.current, true)} onKeyUp={() => onChange(latest.current, true)} />
      <div className="color-hex-row"><label>Hex<input aria-label="Hex color" value={hex} maxLength={7} spellCheck={false}
        onChange={(event) => { const next = event.target.value; setHex(next); setError('');
          if (/^#?[0-9a-f]{6}$/i.test(next)) choose('#' + next.replace(/^#/, ''), false);
        }} onBlur={commitHex}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitHex(); } }} /></label>
        <button className="icon-button" aria-label="Pick color from screen" title={EyeDropper ? 'Pick color from screen' : 'Screen color picking is unavailable'}
          disabled={!EyeDropper || sampling} onClick={() => void sample()}><Pipette size={18} /></button>
      </div>
      {sampling && <p role="status">Click a screen color. Esc to cancel.</p>}
      {error && <p className="color-picker-error" role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
