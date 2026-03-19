chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;
  if (message?.type === 'INIT_MAIN_WORLD_INTERCEPTOR') {
    if (!tabId) {
      sendResponse({ ok: false });
      return;
    }

    chrome.scripting.executeScript(
      {
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: () => {
          if (window.__stickerInterceptorInstalled__) return;
          window.__stickerInterceptorInstalled__ = true;

          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSend = XMLHttpRequest.prototype.send;
          const originalFetch = window.fetch;

          const isRelevantUrl = (url) => {
            if (!url) return false;
            return (
              url.includes('singbada.cn') ||
              url.includes('/apc/order.') ||
              url.includes('/api/') ||
              url.includes('order.Order')
            );
          };

          const collectRecords = (json, url) => {
            const records = [];
            if (json === null || json === undefined) return records;

            const hasOrderLikeField = (obj) => {
              if (!obj || typeof obj !== 'object') return false;
              return [
                'order_sn',
                'old_order_id',
                'order_no',
                'purchase_sn',
                'purchase_order_sn',
                'style_sn',
                'design_code',
                'goods_sn',
                'material_name',
                'supplier_name',
                'send_num',
                'delivery_qty'
              ].some((k) => obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '');
            };

            if (Array.isArray(json)) {
              records.push(...json.filter(hasOrderLikeField));
              return records;
            }

            if (typeof json !== 'object') return records;

            const data = json.data ?? json;

            if (Array.isArray(data)) records.push(...data);
            if (data && Array.isArray(data.list)) records.push(...data.list);
            if (data && Array.isArray(data.data)) records.push(...data.data);

            if (data && Array.isArray(data.material_list)) {
              data.material_list.forEach((material) => {
                records.push({
                  ...data,
                  ...material,
                  __source: 'detail.material_list',
                  __url: url
                });
              });
            }

            if (data && typeof data === 'object' && !Array.isArray(data)) {
              if (hasOrderLikeField(data)) {
                records.push({
                  ...data,
                  __source: 'detail.object',
                  __url: url
                });
              }
            }
            return records.filter(hasOrderLikeField);
          };

          const emit = (url, json) => {
            if (!isRelevantUrl(url)) return;
            const records = collectRecords(json, url);
            if (!records.length) return;
            window.postMessage(
              {
                type: 'STICKER_EXTENSION_INTERCEPT',
                payload: { url, records, raw: json }
              },
              '*'
            );
          };

          const safeParseText = (text) => {
            if (!text || typeof text !== 'string') return null;
            try {
              return JSON.parse(text);
            } catch {
              return null;
            }
          };

          XMLHttpRequest.prototype.open = function (method, url) {
            this.__stickerUrl = url;
            return originalOpen.apply(this, arguments);
          };

          XMLHttpRequest.prototype.send = function () {
            this.addEventListener('load', function () {
              try {
                let json = null;
                if (this.responseType === 'json' && this.response) {
                  json = this.response;
                } else if (this.responseType === '' || this.responseType === 'text') {
                  json = safeParseText(this.responseText);
                }
                if (json) {
                  emit(this.responseURL || this.__stickerUrl || '', json);
                }
              } catch {}
            });
            return originalSend.apply(this, arguments);
          };

          window.fetch = async function (...args) {
            const response = await originalFetch(...args);
            try {
              const clone = response.clone();
              const text = await clone.text();
              const json = safeParseText(text);
              if (json) emit(clone.url || '', json);
            } catch {}
            return response;
          };
        }
      },
      () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      }
    );

    return true;
  }

  if (message?.type === 'STICKER_RECORDS') {
    if (!tabId) {
      sendResponse({ ok: false });
      return;
    }
    chrome.tabs.sendMessage(
      tabId,
      { type: 'STICKER_RECORDS', payload: message.payload || {} },
      () => {
        sendResponse({ ok: !chrome.runtime.lastError });
      }
    );
    return true;
  }
});