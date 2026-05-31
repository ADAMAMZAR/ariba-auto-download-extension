// We inject this to access the window.WIZ_global_data from the main page context
window.postMessage({
  type: 'NOTEBOOKLM_TOKEN_RESPONSE',
  token: window.WIZ_global_data?.SNlM0e,
  app: window.WIZ_global_data?.app || 'notebooklm'
}, '*');

console.log('[NLM Kit Inject] Injector loaded successfully');

// Intercept Fetch requests
const _originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await _originalFetch.apply(this, args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
    if (url.includes('rLM1Ne') && !url.includes('nlm_kit=true')) {
      console.log('[NLM Kit Inject] Intercepted Fetch rLM1Ne request');
      window.postMessage({ type: 'NOTEBOOKLM_SOURCES_UPDATED' }, '*');
    }
  } catch (_) {}
  return response;
};

// Intercept XMLHttpRequest requests
const _originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  try {
    this._url = typeof url === 'string' ? url : url?.toString() ?? '';
  } catch (_) {}
  return _originalOpen.apply(this, [method, url, ...rest]);
};

const _originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function(...args) {
  try {
    if (this._url && this._url.includes('rLM1Ne') && !this._url.includes('nlm_kit=true')) {
      console.log('[NLM Kit Inject] Intercepted XHR rLM1Ne request');
      this.addEventListener('load', () => {
        console.log('[NLM Kit Inject] XHR rLM1Ne completed, triggering check');
        window.postMessage({ type: 'NOTEBOOKLM_SOURCES_UPDATED' }, '*');
      });
    }
  } catch (_) {}
  return _originalSend.apply(this, args);
};
