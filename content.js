(() => {
  if (window.__bingAutomatorLoaded) return;
  window.__bingAutomatorLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 15000, interval = 150, label = 'condition' } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const res = fn();
      if (res) return res;
      await sleep(interval);
    }
    throw new Error(`Timed out waiting for: ${label}`);
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findVisible(selector, root = document) {
    const nodes = root.querySelectorAll(selector);
    for (const el of nodes) {
      if (isElementVisible(el)) return el;
    }
    return null;
  }

  function isSignedOut() {
    const signInBtn = document.querySelector('.aigc-nav__auth-action button[aria-label="Sign in"]');
    return isElementVisible(signInBtn);
  }

  function getWatermarkModal() {
    const dlg = document.querySelector('#gi_nsi_dlg');
    if (dlg && isElementVisible(dlg)) return dlg;

    const overlays = document.querySelectorAll('div.gir-overlay, [role="dialog"]');
    for (const el of overlays) {
      if (isElementVisible(el) && /watermark/i.test(el.textContent || '')) {
        return el;
      }
    }
    return null;
  }

  function dismissWatermarkModal() {
    const dlg = getWatermarkModal();
    if (!dlg) return false;
    const closeBtn = dlg.querySelector('.gi_nsi_cls button[title="Close"], button[title="Close"], button[aria-label="Close"]');
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    return false;
  }

  function triggerBingSignIn() {
    const navSignIn = document.querySelector('.aigc-nav__auth-action button[aria-label="Sign in"]');
    if (navSignIn && isElementVisible(navSignIn)) {
      navSignIn.click();
      return true;
    }
    const dlg = getWatermarkModal();
    if (dlg) {
      const candidates = Array.from(dlg.querySelectorAll('button, a'));
      const signInEl = candidates.find(
        (el) => /sign in/i.test(el.textContent || '') && !/close/i.test(el.getAttribute('title') || '')
      );
      if (signInEl) {
        signInEl.click();
        return true;
      }
    }
    return false;
  }

  async function ensureComposerExpanded() {
    const composer = document.querySelector('gm-composer');
    if (!composer) throw new Error('Could not find <gm-composer> on the page.');

    const arDropdown = composer.querySelector('acf-dropdown.gmc-ar-dropdown');
    const genBtn = composer.querySelector('gm-generate-btn button.gmbtn__btn[title="Generate"]');
    const needsExpand =
      composer.getAttribute('mode') === 'compact' ||
      (arDropdown && !isElementVisible(arDropdown)) ||
      (genBtn && !isElementVisible(genBtn));

    if (needsExpand) {
      const optionsBtn = findVisible('button[title="Options"]', composer);
      if (optionsBtn) {
        optionsBtn.click();
        await waitFor(
          () =>
            composer.getAttribute('mode') === 'create' ||
            isElementVisible(composer.querySelector('gm-generate-btn button.gmbtn__btn[title="Generate"]')),
          { timeout: 5000, label: 'composer to expand' }
        );
        await sleep(200);
      }
    }
    return composer;
  }

  function findFileInputInGmUl(gmUl) {
    if (!gmUl) return null;
    if (gmUl.shadowRoot) {
      const shadowInput = gmUl.shadowRoot.querySelector('input[type="file"]');
      if (shadowInput) return shadowInput;
    }
    const lightInput = gmUl.querySelector('input[type="file"]');
    if (lightInput) return lightInput;
    const all = gmUl.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) {
        const nested = el.shadowRoot.querySelector('input[type="file"]');
        if (nested) return nested;
      }
    }
    return null;
  }

  async function detachReferenceImageIfLoaded() {
    const gmUl = document.querySelector('.gmc__attch .gm-ul');
    if (!gmUl) return;
    if (gmUl.getAttribute('data-state') === 'Loaded') {
      const detachBtn = gmUl.querySelector('div.gm-ul__unattch[title="Detach image"]');
      if (detachBtn) {
        detachBtn.click();
        await waitFor(
          () => gmUl.getAttribute('data-state') === 'Empty',
          { timeout: 5000, label: 'reference image to detach' }
        );
      }
    }
  }

  function dataUrlToFile(dataUrl, filename, mimeType) {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeType || (mimeMatch ? mimeMatch[1] : 'image/png');
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename || 'reference.png', { type: mime });
  }

  async function attachReferenceImage(refImg) {
    if (!refImg || !refImg.dataUrl) return;
    await ensureComposerExpanded();
    await detachReferenceImageIfLoaded();

    const gmUl = await waitFor(() => document.querySelector('.gmc__attch .gm-ul'), {
      timeout: 5000,
      label: '.gm-ul container'
    });

    const acceptConsentIfPresent = () => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const continueBtn = buttons.find(
        (b) =>
          isElementVisible(b) &&
          b.textContent.trim() === 'Continue' &&
          b.closest('[role="dialog"], .b_dialog, .acf-dialog, .gir-overlay')
      );
      if (continueBtn) continueBtn.click();
    };
    acceptConsentIfPresent();

    const fileInput = findFileInputInGmUl(gmUl);
    if (!fileInput) {
      throw new Error('Could not locate reference image <input type="file"> inside .gm-ul shadowRoot.');
    }

    const file = dataUrlToFile(refImg.dataUrl, refImg.name, refImg.type);
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    await sleep(300);
    acceptConsentIfPresent();

    const state = await waitFor(() => {
      const s = gmUl.getAttribute('data-state');
      if (s === 'Loaded' || s === 'Error') return s;
      return null;
    }, { timeout: 15000, label: 'reference image upload' });

    if (state === 'Error') {
      throw new Error('Bing rejected the reference image (unsupported format or too small; try PNG/JPEG >= 64x64).');
    }
  }

  async function setAspectRatio(arValue) {
    if (!arValue) return;
    const dropdown = document.querySelector('acf-dropdown.gmc-ar-dropdown');
    if (!dropdown || !isElementVisible(dropdown)) return;

    const combobox = dropdown.querySelector('div.acf-dropdown__combobox[role="combobox"]');
    if (!combobox) return;

    combobox.click();
    await sleep(200);

    const listboxId = combobox.getAttribute('aria-controls');
    const listbox = (listboxId && document.getElementById(listboxId)) || dropdown.querySelector('[role="listbox"]') || dropdown;
    const option = listbox.querySelector(`li[role="option"][data-value="${arValue}"]`);
    if (option) {
      option.click();
      await sleep(150);
    }
  }

  async function fillPromptAndGenerate(promptText, aspectRatio) {
    await ensureComposerExpanded();
    await setAspectRatio(aspectRatio);

    const textarea = await waitFor(
      () => findVisible('textarea.gmc__textarea[name="gmc__textarea"]'),
      { timeout: 5000, label: 'prompt textarea' }
    );

    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, promptText);
    } else {
      textarea.value = promptText;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    const genBtn = await waitFor(() => {
      const btn = document.querySelector('gm-generate-btn button.gmbtn__btn[title="Generate"]');
      if (btn && isElementVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        return btn;
      }
      return null;
    }, { timeout: 5000, label: 'enabled Generate button' });

    genBtn.click();
  }

  /** Bing image URL of an <img>, also when it is lazy-loaded (src still a placeholder). */
  function bingImageSrc(img) {
    const candidates = [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-original')];
    return candidates.find((u) => typeof u === 'string' && /(^|\/\/)(th\.bing\.com|[^/]*\.bing\.com\/th\/id\/)/.test(u)) || '';
  }

  /** Same image at a different size has the same /th/id/... path. */
  function imageKey(url) {
    try {
      const u = new URL(url, location.href);
      return u.pathname;
    } catch {
      return url;
    }
  }

  /**
   * All images of the current batch (normally 4). Reads the batch strip under several selectors, because the
   * strip may render after the main image or Bing may rename its classes; the large main image is only used
   * when no strip exists at all.
   */
  function getCurrentBatchUrls() {
    const stripSelectors = [
      '.aigc-batch-strip img.aigc-batch__thumb',
      '.aigc-batch-strip img',
      'button.aigc-batch__item img',
      '[data-batch-index] img'
    ];
    for (const sel of stripSelectors) {
      const seen = new Set();
      const urls = [];
      for (const img of document.querySelectorAll(sel)) {
        const src = bingImageSrc(img);
        if (!src) continue;
        const key = imageKey(src);
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(src);
      }
      if (urls.length > 0) return urls;
    }

    const mainImg = document.querySelector('img.aigc-display__img');
    const mainSrc = mainImg && isElementVisible(mainImg) ? bingImageSrc(mainImg) : '';
    return mainSrc ? [mainSrc] : [];
  }

  async function selectBatchItem(batchIndex) {
    const idx = Number(batchIndex) || 0;
    const item = document.querySelector(`.aigc-batch-strip button.aigc-batch__item[data-batch-index="${idx}"]`);
    if (item && isElementVisible(item)) {
      item.click();
      await sleep(250);
    }
  }

  async function waitForGenerationComplete({ prevUrl, prevImages, autoDismissWatermarkModal, timeout = 300000 }) {
    const start = Date.now();
    let sawGeneratingState = false;
    let firstReadyAt = 0;

    while (Date.now() - start < timeout) {
      if (autoDismissWatermarkModal) {
        dismissWatermarkModal();
      }

      const dlBtn = document.querySelector('.aigc-dl-btn button');
      const isDlReady =
        Boolean(dlBtn) &&
        isElementVisible(dlBtn) &&
        !dlBtn.disabled &&
        dlBtn.getAttribute('aria-disabled') !== 'true';

      const currentImages = getCurrentBatchUrls();
      const urlChanged = window.location.href !== prevUrl;
      const imagesChanged =
        currentImages.length > 0 &&
        (prevImages.length === 0 ||
          currentImages.length !== prevImages.length ||
          currentImages.some((u, i) => u !== prevImages[i]));

      if (!isDlReady || urlChanged) {
        sawGeneratingState = true;
      }

      const errBanner = document.querySelector('.aigc-error, .gi_err, [role="alert"].aigc-alert');
      if (errBanner && isElementVisible(errBanner) && errBanner.textContent.trim().length > 0) {
        throw new Error(`Bing reported an error: ${errBanner.textContent.trim().slice(0, 160)}`);
      }

      if ((sawGeneratingState || imagesChanged) && isDlReady && imagesChanged) {
        if (currentImages.length >= 4) {
          await sleep(500);
          if (autoDismissWatermarkModal) dismissWatermarkModal();
          return getCurrentBatchUrls();
        }
        // Fewer than 4 (some filtered, or the batch strip is still loading): wait up to 15 s for the rest
        if (!firstReadyAt) firstReadyAt = Date.now();
        if (Date.now() - firstReadyAt >= 15000) {
          if (autoDismissWatermarkModal) dismissWatermarkModal();
          return getCurrentBatchUrls();
        }
      } else {
        firstReadyAt = 0;
      }

      await sleep(500);
    }

    throw new Error('Timed out waiting for Bing image generation to finish.');
  }

  async function handleRunGenerate(payload) {
    const { prompt, aspectRatio, referenceImage, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    if (referenceImage && referenceImage.dataUrl) {
      await attachReferenceImage(referenceImage);
    } else {
      await detachReferenceImageIfLoaded();
    }

    await fillPromptAndGenerate(prompt, aspectRatio);
    const urls = await waitForGenerationComplete({
      prevUrl,
      prevImages,
      autoDismissWatermarkModal
    });
    return { ok: true, urls };
  }

  async function handleRunEditImage(payload) {
    const { batchIndex, editPrompt, aspectRatio, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    await selectBatchItem(batchIndex);

    const editBtn = await waitFor(
      () => findVisible('.aigc-card__actions button[title="Edit image"], button[title="Edit image"]'),
      { timeout: 5000, label: 'visible Edit image button (generate an image first)' }
    );
    editBtn.click();

    await waitFor(() => {
      const gmUl = document.querySelector('.gmc__attch .gm-ul');
      return gmUl && gmUl.getAttribute('data-state') === 'Loaded';
    }, { timeout: 8000, label: 'Edit image attachment loaded' });

    await fillPromptAndGenerate(editPrompt, aspectRatio);
    const urls = await waitForGenerationComplete({
      prevUrl,
      prevImages,
      autoDismissWatermarkModal
    });
    return { ok: true, urls };
  }

  async function handleRunRestyle(payload) {
    const { batchIndex, styleKey, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    await selectBatchItem(batchIndex);

    const restyleBtn = await waitFor(
      () => findVisible('.aigc-restyle .aigc-restyle-btn button[title="Restyle"]'),
      { timeout: 5000, label: 'visible Restyle button (generate an image first)' }
    );
    restyleBtn.click();

    const styleOption = await waitFor(
      () => findVisible(`section.aigc-restyle__menu button.aigc-restyle__option[data-style="${styleKey}"]`),
      { timeout: 5000, label: `Restyle option (${styleKey})` }
    );
    styleOption.click();

    const urls = await waitForGenerationComplete({
      prevUrl,
      prevImages,
      autoDismissWatermarkModal
    });
    return { ok: true, urls };
  }

  function pollGenerationSnapshot({ autoDismissWatermarkModal } = {}) {
    if (autoDismissWatermarkModal) {
      dismissWatermarkModal();
    }

    const dlBtn = document.querySelector('.aigc-dl-btn button');
    const dlReady =
      Boolean(dlBtn) &&
      isElementVisible(dlBtn) &&
      !dlBtn.disabled &&
      dlBtn.getAttribute('aria-disabled') !== 'true';

    const images = getCurrentBatchUrls();

    const errBanner = document.querySelector('.aigc-error, .gi_err, [role="alert"].aigc-alert');
    const errorText =
      errBanner && isElementVisible(errBanner) && errBanner.textContent.trim().length > 0
        ? errBanner.textContent.trim().slice(0, 180)
        : null;

    return {
      ok: true,
      url: window.location.href,
      dlReady,
      images,
      errorText
    };
  }

  async function handleSubmitGenerate(payload) {
    const { prompt, aspectRatio, referenceImage, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    if (referenceImage && referenceImage.dataUrl) {
      await attachReferenceImage(referenceImage);
    } else {
      await detachReferenceImageIfLoaded();
    }

    await fillPromptAndGenerate(prompt, aspectRatio);
    return { ok: true, prevUrl, prevImages };
  }

  async function handleSubmitEditImage(payload) {
    const { batchIndex, editPrompt, aspectRatio, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    await selectBatchItem(batchIndex);

    const editBtn = await waitFor(
      () => findVisible('.aigc-card__actions button[title="Edit image"], button[title="Edit image"]'),
      { timeout: 5000, label: 'visible Edit image button (generate an image first)' }
    );
    editBtn.click();

    await waitFor(() => {
      const gmUl = document.querySelector('.gmc__attch .gm-ul');
      return gmUl && gmUl.getAttribute('data-state') === 'Loaded';
    }, { timeout: 8000, label: 'Edit image attachment loaded' });

    await fillPromptAndGenerate(editPrompt, aspectRatio);
    return { ok: true, prevUrl, prevImages };
  }

  async function handleSubmitRestyle(payload) {
    const { batchIndex, styleKey, autoDismissWatermarkModal } = payload;
    if (autoDismissWatermarkModal) dismissWatermarkModal();
    const prevUrl = window.location.href;
    const prevImages = getCurrentBatchUrls();

    await selectBatchItem(batchIndex);

    const restyleBtn = await waitFor(
      () => findVisible('.aigc-restyle .aigc-restyle-btn button[title="Restyle"]'),
      { timeout: 5000, label: 'visible Restyle button (generate an image first)' }
    );
    restyleBtn.click();

    const styleOption = await waitFor(
      () => findVisible(`section.aigc-restyle__menu button.aigc-restyle__option[data-style="${styleKey}"]`),
      { timeout: 5000, label: `Restyle option (${styleKey})` }
    );
    styleOption.click();

    return { ok: true, prevUrl, prevImages };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { type, payload } = message || {};

    if (type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'CHECK_STATUS') {
      sendResponse({
        ok: true,
        url: window.location.href,
        signedOut: isSignedOut(),
        hasWatermarkModal: Boolean(getWatermarkModal()),
        currentImages: getCurrentBatchUrls()
      });
      return false;
    }

    if (type === 'POLL_GENERATION') {
      sendResponse(pollGenerationSnapshot(payload));
      return false;
    }

    if (type === 'TRIGGER_SIGN_IN') {
      sendResponse({ ok: triggerBingSignIn() });
      return false;
    }

    if (type === 'DISMISS_WATERMARK_MODAL') {
      sendResponse({ ok: dismissWatermarkModal() });
      return false;
    }

    if (type === 'SUBMIT_GENERATE') {
      handleSubmitGenerate(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (type === 'SUBMIT_EDIT_IMAGE') {
      handleSubmitEditImage(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (type === 'SUBMIT_RESTYLE') {
      handleSubmitRestyle(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (type === 'RUN_GENERATE') {
      handleRunGenerate(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (type === 'RUN_EDIT_IMAGE') {
      handleRunEditImage(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    if (type === 'RUN_RESTYLE') {
      handleRunRestyle(payload)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    return false;
  });
})();
