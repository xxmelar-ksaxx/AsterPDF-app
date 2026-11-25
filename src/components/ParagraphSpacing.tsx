import { t } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { ListCollapse } from 'lucide-react';
import type { TextAppearance } from '../pdf/overlays';

export default function ParagraphSpacing({ appearance, onChange }: {
  appearance: TextAppearance; onChange: (patch: TextAppearance) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const value = appearance.lineSpacing?.toString() ?? '';
  useEffect(() => { setDraft(value); }, [value]);
  const place = () => {
    if (!popup.current || !trigger.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    popup.current.style.left = `${Math.min(bounds.left, window.innerWidth - 244)}px`;
    popup.current.style.top = `${bounds.bottom + 6}px`;
  };
  return <div className="paragraph-spacing" data-added-text-controls>
    <button ref={trigger} popoverTarget={id} aria-label={t("Paragraph spacing")} title={t("Line and paragraph spacing")} onClick={place}><ListCollapse size={17}/></button>
    <div id={id} ref={popup} popover="auto" className="paragraph-spacing-popup" data-added-text-controls>
      <label>{t("Line spacing (×)")} <input aria-label={t("Line spacing")} type="number" min=".75" max="3" step=".05" placeholder={t("Auto")}
        value={draft} onChange={event => {
          const raw = event.target.value, next = event.target.valueAsNumber;
          setDraft(raw);
          if (!raw) onChange({lineSpacing:undefined});
          else if (next >= .75 && next <= 3) onChange({lineSpacing:next});
        }} onBlur={() => setDraft(value)} /></label>
      {appearance.paragraphGap !== undefined ? <label>{t("After Enter (pt)")} <input type="number" min="0" max="2000" step="0.5" aria-label={t("Paragraph gap in points")}
        value={appearance.paragraphGap} onChange={event => { const value = event.target.valueAsNumber;
          if (Number.isFinite(value) && value >= 0 && value <= 2000) onChange({paragraphGap:value}); }} /></label> : <label>{t("After Enter")} <select aria-label={t("Spacing after paragraph break")} value={appearance.breakSpacing || 0}
        onChange={event => onChange({breakSpacing:Number(event.target.value)})}>
        <option value={0}>{t("No extra space")}</option><option value={1}>{t("1 blank line")}</option><option value={2}>{t("2 blank lines")}</option>
      </select></label>}
      <small>{t("Shift+Enter starts a line within the paragraph.")}</small>
    </div>
  </div>;
}
