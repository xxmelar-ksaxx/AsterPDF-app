import { useLayoutEffect, useRef } from 'react';
import { FileText } from 'lucide-react';

// Let the feedback paint before PDF preparation starts using the main thread.
export function paintSaveFeedback() {
  return new Promise<void>((resolve) => {
    let frame = 0;
    const done = () => { clearTimeout(fallback); cancelAnimationFrame(frame); resolve(); };
    const fallback = window.setTimeout(done, 100); // Background windows may not paint.
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done); });
  });
}

export default function SaveFeedback({ message, title = 'Saving your PDF' }: { message: string | null; title?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lastMessage = useRef('Preparing your PDF…');
  if (message) lastMessage.current = message;
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (message && !element.open) element.showModal();
    else if (!message && element.open) element.close();
  }, [message]);

  return <dialog ref={dialog} className="save-feedback" aria-labelledby="save-feedback-title"
    aria-describedby="save-feedback-message" aria-busy={Boolean(message)}
    onCancel={(event) => event.preventDefault()} onKeyDown={(event) => event.stopPropagation()}
    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <div className="save-feedback-orbit" aria-hidden="true">
      <svg viewBox="0 0 88 88"><circle className="save-feedback-track" cx="44" cy="44" r="40" />
        <circle className="save-feedback-ring" cx="44" cy="44" r="40" /></svg>
      <div className="save-feedback-document"><FileText size={28} strokeWidth={1.5} /></div>
    </div>
    <h2 id="save-feedback-title">{title}</h2>
    <p id="save-feedback-message" role="status" aria-live="polite">{message || lastMessage.current}</p>
  </dialog>;
}
