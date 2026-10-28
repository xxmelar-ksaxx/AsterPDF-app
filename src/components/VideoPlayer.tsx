import { useEffect, useRef, useState } from 'react';
import { Play, X } from 'lucide-react';
import type { OverlayObject } from '../pdf/overlays';
import { videoUrl } from '../pdf/video-assets';

export default function VideoPlayer({ object, width, height }: { object: OverlayObject; width: number; height: number }) {
  const host = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState('');
  const url = object.videoId ? videoUrl(object.videoId) : undefined;
  useEffect(() => {
    const element = video.current;
    return () => { element?.pause(); };
  }, [started, url]);
  useEffect(() => {
    const pause = () => { video.current?.pause(); setOpen(false); };
    const observer = new IntersectionObserver(entries => { if (!entries[0]?.isIntersecting) pause(); });
    if (host.current) observer.observe(host.current);
    const visibility = () => { if (document.hidden) pause(); };
    window.addEventListener('blur', pause); document.addEventListener('visibilitychange', visibility);
    return () => { observer.disconnect(); window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', visibility); video.current?.pause(); };
  }, []);
  useEffect(() => {
    if (started && open && video.current?.paused) void video.current.play().catch(() => { setOpen(false); setError('This video could not play. Use an MP4 with H.264 video and AAC audio.'); });
  }, [started, open, url]);
  return <div ref={host} className={`pdf-video${open ? ' open' : ''}`} data-video-id={object.id}
    style={{ left: object.x * width, top: object.y * height, width: object.width * width, height: object.height * height }}
    onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onContextMenu={event => { if (open) { event.preventDefault(); event.stopPropagation(); } }}>
    {started && url && <video ref={video} src={url} poster={object.image} controls={open} playsInline preload="metadata" hidden={!open}
      aria-label={object.name || 'Embedded video'} onPlay={() => setOpen(true)}
      onError={() => { setOpen(false); setError('This video cannot be played on this device.'); }} />}
    {!open && <button className="video-play" aria-label={`Play ${object.name || 'video'}`} title="Play video"
      onClick={() => { if (!url) { setError('The embedded video is unavailable.'); return; } setError(''); setStarted(true); setOpen(true); }}><Play size={26} fill="currentColor" /></button>}
    {open && <button className="video-close" aria-label="Stop video" title="Stop video" onClick={() => { video.current?.pause(); setOpen(false); }}><X size={16} /></button>}
    {error && <span className="video-error" role="alert">{error}</span>}
  </div>;
}
