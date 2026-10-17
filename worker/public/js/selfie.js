// Take a selfie in the browser: live camera preview with a file-picker fallback. The picture is cropped square,
// shrunk to 256px and re-encoded as a JPEG, which also drops any camera metadata. Resolves with a data URL, or null if cancelled.
import { h, mount } from '/js/dom.js';

const SIZE = 256;
const MAX_BYTES = 45_000; // the server accepts up to 60,000

function encode(source, sw, sh) {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const m = Math.min(sw, sh);
  g.drawImage(source, (sw - m) / 2, (sh - m) / 2, m, m, 0, 0, SIZE, SIZE);
  let q = 0.8, out = c.toDataURL('image/jpeg', q);
  while (out.length * 0.75 > MAX_BYTES && q > 0.35) { q -= 0.08; out = c.toDataURL('image/jpeg', q); }
  return out;
}

export function selfieModal({ title = 'Add your photo', note = '' } = {}) {
  return new Promise((resolve) => {
    let stream = null, shot = null, done = false;
    const prevOverflow = document.body.style.overflow;
    const video = h('video', { class: 'selfie-video', playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera preview' });
    const img = h('img', { class: 'selfie-img', alt: 'Your photo', hidden: true });
    const stage = h('div', { class: 'selfie-stage' }, video, img, h('span', { class: 'selfie-ring', 'aria-hidden': 'true' }));
    const msg = h('p', { class: 'hint', style: 'text-align:center;min-height:1.4em', role: 'status' });
    const picker = h('input', { type: 'file', accept: 'image/*', capture: 'user', hidden: true });
    const snap = h('button', { class: 'btn primary block', type: 'button' }, 'Take photo');
    const use = h('button', { class: 'btn primary block', type: 'button', hidden: true }, 'Agree and use this photo');
    const retake = h('button', { class: 'btn ghost block', type: 'button', hidden: true }, 'Retake');
    const choose = h('button', { class: 'btn ghost block', type: 'button' }, 'Choose or take a photo instead');

    function close(result) {
      if (done) return; done = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      overlay.remove(); document.body.style.overflow = prevOverflow;
      resolve(result);
    }
    function review(dataUrl) {
      shot = dataUrl; img.src = dataUrl; img.hidden = false; video.hidden = true;
      snap.hidden = true; choose.hidden = true; use.hidden = false; retake.hidden = false; msg.textContent = '';
    }
    function live() {
      shot = null; img.hidden = true; video.hidden = !stream; snap.hidden = !stream; choose.hidden = false; use.hidden = true; retake.hidden = true;
    }
    async function fromFile(file) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        review(encode(bmp, bmp.width, bmp.height));
      } catch { msg.textContent = 'That picture could not be read. Try another.'; }
    }
    snap.onclick = () => { if (video.videoWidth) review(encode(video, video.videoWidth, video.videoHeight)); };
    retake.onclick = live;
    use.onclick = () => close(shot);
    choose.onclick = () => picker.click();
    picker.onchange = () => { if (picker.files && picker.files[0]) fromFile(picker.files[0]); picker.value = ''; };

    const overlay = h('div', { class: 'overlay selfie', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'spread', style: 'width:100%;max-width:460px' }, h('button', { class: 'btn ghost small', type: 'button', onclick: () => close(null) }, 'Cancel'), h('span', { class: 'chip' }, 'Selfie')),
      h('h2', { style: 'margin-top:14px;text-align:center' }, title),
      note && h('p', { class: 'muted', style: 'text-align:center;max-width:340px;margin-top:6px' }, note),
      stage, msg,
      h('div', { class: 'stack', style: 'width:100%;max-width:340px;margin-top:10px' }, snap, use, retake, choose, picker),
      // Consent: what the photo is for, who sees it, how long it is kept, and how to take it back.
      h('p', { class: 'hint', style: 'text-align:center;max-width:340px;margin-top:14px' },
        'Your photo is used only so door staff at events and offices that ask for it can match your face to your pass. Nobody else sees it, and it is never used for automatic face recognition. It is deleted 30 days after you last set it unless a pass still needs it, and you can delete it any time under Me. ',
        h('a', { href: '/privacy/#photos', target: '_blank', rel: 'noopener' }, 'Privacy policy')));
    document.body.style.overflow = 'hidden';
    document.body.append(overlay);
    overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close(null));

    snap.hidden = true; // until the camera is ready
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false })
        .then((s) => { if (done) { s.getTracks().forEach((t) => t.stop()); return; } stream = s; video.srcObject = s; video.play().catch(() => {}); live(); snap.focus(); })
        .catch(() => { msg.textContent = 'The camera is not available. You can choose or take a photo instead.'; live(); });
    } else { msg.textContent = 'This browser cannot open the camera. Choose or take a photo instead.'; live(); }
  });
}
