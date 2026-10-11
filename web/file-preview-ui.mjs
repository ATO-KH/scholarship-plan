const previews = new WeakMap();

// Keep the waiting state until the media itself is ready, not just its metadata.
export function mountFilePreview(container, getFile, {
  loading,
  isCurrent = () => container.isConnected,
  label = 'Evidence',
} = {}) {
  previews.get(container)?.dispose();
  const panel = document.createElement('div');
  panel.className = 'file-preview';
  const frame = document.createElement('div');
  frame.className = 'file-preview-frame';
  frame.dataset.state = 'loading';
  frame.setAttribute('aria-busy', 'true');
  const indicator = document.createElement('div');
  indicator.className = 'file-preview-loader';
  indicator.innerHTML = loading(`Loading ${label.toLowerCase()}…`);
  frame.append(indicator);
  panel.append(frame);
  container.replaceChildren(panel);

  let disposed = false, settled = false, media = null, objectUrl = null, pdfTimeout = null;
  const abort = new AbortController();
  const active = () => !disposed && isCurrent() && container.isConnected && panel.parentNode === container;
  const releaseMedia = () => {
    clearTimeout(pdfTimeout);
    if (media) media.onload = media.onerror = null;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timeout);
    abort.abort();
    releaseMedia();
    observer.disconnect();
    if (previews.get(container)?.dispose === dispose) previews.delete(container);
  };
  const observer = new MutationObserver(() => { if (!active()) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });

  function finish() {
    if (!active() || settled) return;
    settled = true;
    clearTimeout(timeout);
    clearTimeout(pdfTimeout);
    if (media) media.onload = media.onerror = null;
    indicator.remove();
    frame.dataset.state = 'ready';
    frame.setAttribute('aria-busy', 'false');
  }

  function fail(message = `This ${label.toLowerCase()} could not be loaded.`) {
    if (!active() || settled) return;
    settled = true;
    clearTimeout(timeout);
    abort.abort();
    // The Open PDF link may still use this blob. Revoke it only when this
    // preview is disposed (closed, replaced, or retried), not on viewer failure.
    clearTimeout(pdfTimeout);
    if (media) media.onload = media.onerror = null;
    frame.dataset.state = 'error';
    frame.setAttribute('aria-busy', 'false');
    const error = document.createElement('p');
    error.className = 'error'; error.setAttribute('role', 'alert'); error.textContent = message;
    const retry = document.createElement('button');
    retry.className = 'button ghost'; retry.type = 'button'; retry.textContent = 'Retry preview';
    retry.onclick = () => mountFilePreview(container, getFile, { loading, isCurrent, label });
    frame.replaceChildren(error, retry);
  }
  const timeout = setTimeout(() => fail('This preview is taking too long. Try again or open the file directly.'), 120_000);
  previews.set(container, { dispose });

  (async () => {
    const file = typeof getFile === 'function' ? await getFile() : getFile;
    if (!active() || settled) return;
    const url = file.previewUrl || file.downloadUrl;
    if (!url) throw Error(`This ${label.toLowerCase()} is unavailable.`);
    const pdf = file.mime === 'application/pdf';
    const link = document.createElement('a');
    link.className = 'button ghost small'; link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = pdf ? 'Open PDF' : 'Open full size';
    const actions = document.createElement('div'); actions.className = 'file-preview-actions'; actions.append(link); panel.append(actions);

    if (pdf && navigator.pdfViewerEnabled === false) {
      if (/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(url)) {
        const bytes = Uint8Array.from(atob(url.split(',')[1]), char => char.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        link.href = objectUrl;
      }
      const hint = document.createElement('p'); hint.className = 'footnote'; hint.textContent = 'Open the PDF to view this file.';
      frame.append(hint); finish(); return;
    }
    if (!pdf && !file.mime?.startsWith('image/')) {
      const hint = document.createElement('p'); hint.className = 'footnote'; hint.textContent = 'Open the file to view it.';
      frame.append(hint); finish(); return;
    }
    media = document.createElement(pdf ? 'iframe' : 'img');
    media.className = `file-preview-media ${pdf ? 'inline-evidence-pdf' : 'inline-evidence-image'}`;
    media.onerror = () => fail();
    if (pdf) {
      media.title = `${label} PDF`;
      // Fetch first so authorization/network failures do not masquerade as an
      // iframe load event. The loader remains through the PDF viewer's load.
      let bytes;
      if (/^data:application\/pdf;base64,[A-Za-z0-9+/=]+$/.test(url)) {
        bytes = new Blob([Uint8Array.from(atob(url.split(',')[1]), char => char.charCodeAt(0))], { type: 'application/pdf' });
      } else {
        const response = await fetch(url, { credentials: 'same-origin', signal: abort.signal });
        if (!response.ok) throw Error(`This ${label.toLowerCase()} could not be loaded. Try again.`);
        bytes = await response.blob();
      }
      if (!active() || settled) return;
      if (bytes.type.split(';')[0] !== 'application/pdf') throw Error('This file could not be opened as a PDF.');
      objectUrl = URL.createObjectURL(bytes);
      link.href = objectUrl;
      media.onload = finish;
      media.src = objectUrl;
      frame.prepend(media);
      // Some mobile and in-app browsers advertise PDF support but never load
      // an embedded viewer. Keep the available file link and end that wait.
      pdfTimeout = setTimeout(() => {
        if (!active() || settled) return;
        media.onload = media.onerror = null;
        media.remove();
        const hint = document.createElement('p');
        hint.className = 'footnote'; hint.textContent = 'Your browser could not show this PDF here. Use Open PDF to view it.';
        frame.append(hint);
        finish();
      }, 5_000);
    } else {
      media.alt = label;
      media.decoding = 'async';
      let decoding = false;
      const loaded = async () => {
        if (!active() || settled || decoding) return;
        if (!media.naturalWidth) { fail(); return; }
        decoding = true;
        try {
          if (media.decode) await media.decode();
          finish();
        } catch { fail(); }
      };
      media.onload = loaded;
      media.src = url;
      frame.prepend(media);
      // Cached and data-URL images may be complete before their load callback.
      if (media.complete) queueMicrotask(loaded);
    }
  })().catch(error => { if (!abort.signal.aborted) fail(error.message); });
  return { dispose };
}
