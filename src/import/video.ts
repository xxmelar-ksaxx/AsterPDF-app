export async function importVideo(file: File) {
  if (!/\.mp4$/i.test(file.name)) throw new Error('Choose an MP4 video. H.264 video with AAC audio is recommended.');
  if (!file.size || file.size > 250 * 1024 * 1024) throw new Error('Choose an MP4 video smaller than 250 MB.');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { video.onloadeddata = null; video.onerror = null; reject(new Error('The video took too long to load.')); }, 20000);
      video.onloadeddata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error('This video cannot be read. Use MP4 with H.264 video and AAC audio.')); };
      video.src = url;
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error('This file has no playable video track.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
    const videoId = crypto.randomUUID();
    return { dataUrl: canvas.toDataURL('image/png'), aspect: video.videoWidth / video.videoHeight, videoId, videoFile: file, name: file.name };
  } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
}
