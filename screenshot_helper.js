(async () => {
  // No DOM guard here — background already injects this into the correct frame.
  // For screenshotOnly (allFrames), the session lock below handles dedup.

  const LOCK = 'ssHelperLock';
  const lockCheck = await chrome.storage.session.get(LOCK);
  if (lockCheck[LOCK]) return;
  await chrome.storage.session.set({ [LOCK]: true });

  const wait = ms => new Promise(r => setTimeout(r, ms));

  // Wraps captureViewport with a 5-second timeout so the loop can't hang forever
  async function captureViewport() {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ dataUrl: null }), 5000);
      chrome.runtime.sendMessage({ action: 'captureViewport' }, resp => {
        clearTimeout(timer);
        resolve(resp || { dataUrl: null });
      });
    });
  }

  try {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const fullH = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      vpH
    );
    const savedY = window.scrollY;

    window.scrollTo(0, 0);
    await wait(400);

    const slices = [];
    let prevY = -1;

    for (let targetY = 0; targetY < fullH; targetY += vpH) {
      window.scrollTo(0, targetY);
      await wait(250);

      const actualY = window.scrollY;
      if (actualY === prevY && targetY > 0) break; // hit bottom
      prevY = actualY;

      const resp = await captureViewport();
      if (resp?.dataUrl) {
        slices.push({ dataUrl: resp.dataUrl, y: actualY });
      }
    }

    window.scrollTo(0, savedY);

    if (!slices.length) {
      chrome.runtime.sendMessage({ action: 'deliverScreenshot', dataUrl: null });
      return;
    }

    // Stitch slices into one image
    const canvas = document.createElement('canvas');
    canvas.width  = vpW;
    canvas.height = fullH;
    const ctx = canvas.getContext('2d');

    for (const { dataUrl, y } of slices) {
      await new Promise(resolve => {
        const img = new Image();
        img.onload  = () => { ctx.drawImage(img, 0, y); resolve(); };
        img.onerror = resolve;
        img.src = dataUrl;
      });
    }

    const finalDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    chrome.runtime.sendMessage({ action: 'deliverScreenshot', dataUrl: finalDataUrl });

  } catch (e) {
    console.error('[Ariba Ext] screenshot_helper error:', e);
    chrome.runtime.sendMessage({ action: 'deliverScreenshot', dataUrl: null });
  } finally {
    await chrome.storage.session.remove(LOCK);
  }
})();
