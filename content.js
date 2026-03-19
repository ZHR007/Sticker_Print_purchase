let cachedApiRecords = [];
const isTopWindow = window.top === window;
let mainWorldInjected = null;
let lastCaptureAt = 0;
let lastCaptureUrl = '';
let captureEnabled = false;
let currentAuthToken = '';
let refreshInProgress = false;
let refreshTimer = null;
let refreshResolver = null;
const BUTTON_TEXT_REFRESH = '刷新数据';
const BUTTON_TEXT_PRINT = '打印贴纸';
const DEBUG_PREFIX = '[StickerDebug]';
const TARGET_ORIGIN = 'https://yy.singbada.cn';
const TARGET_PATH_PREFIX = '/purchasingManagement';

function maskToken(token) {
  if (!token) return '';
  const str = String(token);
  if (str.length <= 12) return str;
  return `${str.slice(0, 6)}...${str.slice(-6)} (len:${str.length})`;
}

function debugLog(...args) {
  console.log(DEBUG_PREFIX, ...args);
}

function debugWarn(...args) {
  console.warn(DEBUG_PREFIX, ...args);
}

function debugError(...args) {
  console.error(DEBUG_PREFIX, ...args);
}

function isTargetPurchasingPage() {
  return window.location.origin === TARGET_ORIGIN && window.location.pathname.startsWith(TARGET_PATH_PREFIX);
}

function removeActionButtons() {
  const refreshBtn = document.getElementById('sticker-refresh-btn');
  if (refreshBtn) refreshBtn.remove();
  const printBtn = document.getElementById('sticker-print-btn');
  if (printBtn) printBtn.remove();
}

function normalizeDate(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const ts = String(value).length > 10 ? Number(value) : Number(value) * 1000;
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString().replace(/\//g, '-');
  }
  const str = String(value).trim();
  if (str.includes(' ')) return str.split(' ')[0];
  return str;
}

function normalizeQty(value) {
  if (value === null || value === undefined || value === '') return '0.00';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return n.toFixed(2);
}

function pick(obj, keys) {
  for (const key of keys) {
    const v = obj?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

function expandRecordsForPrint(records) {
  const out = [];
  records.forEach((record) => {
    const detail = record?.detail;
    if (Array.isArray(detail) && detail.length > 0) {
      detail.forEach((d) => {
        const merged = { ...record, ...d };
        delete merged.detail;
        out.push(merged);
      });
      return;
    }
    out.push(record);
  });
  return out;
}

function mapApiItemToSticker(apiItem) {
  const normalizeString = (value) => {
    if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      const candidate = value?.supplier_name;
      if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') return String(candidate);
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };
  const supplierName = normalizeString(apiItem.sewing_factory_name).trim();
  const supplierDisplay = !supplierName || supplierName === '裁床车间' ? '-' : supplierName;
  return {
    orderNo: normalizeString(pick(apiItem, ['old_order_ids', 'old_order_id', 'order_sn', 'order_no'])),
    skc: normalizeString(pick(apiItem, ['style_sns', 'style_sn', 'skc', 'sku'])),
    purchaseOrderNo: normalizeString(pick(apiItem, ['purchase_sn'])),
    itemNo: normalizeString(pick(apiItem, ['design_code'])),
    materialName: normalizeString(pick(apiItem, ['material_name', 'om_material_name', 'supplier_material_name', 'goods_name', 'name'])),
    color: normalizeString(pick(apiItem, ['material_color', 'supplier_color', 'color_name', 'color'])),
    materialType: normalizeString(pick(apiItem, ['material_item', 'order_material_items', 'type_name', 'material_type', 'category_name'])),
    supplier: supplierDisplay,
    purchaseDate: normalizeDate(pick(apiItem, ['create_time', 'order_time', 'purchase_time', 'created_at'])),
    deliveryQty: normalizeQty(pick(apiItem, ['actual_num', 'delivery_qty', 'send_num', 'arrival_num', 'quantity', 'num'])),
    deliveryUnit: normalizeString(pick(apiItem, ['target_unit', 'delivery_unit', 'customer_unit_name', 'base_unit_name']))
  };
}

function recordScore(r) {
  const candidateKeys = [
    'old_order_ids',
    'old_order_id',
    'order_sn',
    'style_sns',
    'style_sn',
    'design_code',
    'material_name',
    'material_color',
    'material_item',
    'purchase_sn',
    'supplier_name',
    'actual_num',
    'target_unit'
  ];
  return candidateKeys.reduce((acc, k) => (r?.[k] !== undefined && r?.[k] !== null && String(r[k]).trim() !== '' ? acc + 1 : acc), 0);
}

function dedupeAndSort(records) {
  const map = new Map();
  records.forEach((r) => {
    const key = [
      pick(r, ['old_order_ids', 'old_order_id', 'order_sn', 'order_no']),
      pick(r, ['purchase_sn', 'purchase_order_sn', 'po_sn']),
      pick(r, ['material_name', 'name']),
      pick(r, ['style_sns', 'style_sn', 'design_code'])
    ].join('|');
    const old = map.get(key);
    if (!old || recordScore(r) >= recordScore(old)) {
      map.set(key, r);
    }
  });
  return Array.from(map.values());
}

function isPrimaryOrderListUrl(url) {
  return String(url || '').includes('/apc/order.Order/index');
}

function isOrderListLikeUrl(url) {
  const text = String(url || '');
  return (
    text.includes('/apc/order.Order/index') ||
    text.includes('/apc/order.') ||
    text.includes('order.Order')
  );
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findQueryButton() {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], .el-button'));
  return candidates.find((el) => {
    if (!isVisibleElement(el)) return false;
    if (el.id === 'sticker-print-btn' || el.id === 'sticker-refresh-btn') return false;
    const text = (el.innerText || el.textContent || '').trim();
    return text === '查询';
  }) || null;
}

function clearRefreshWaiter() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  refreshResolver = null;
  refreshInProgress = false;
}

function setRefreshButtonState(loading) {
  const refreshBtn = document.getElementById('sticker-refresh-btn');
  if (!refreshBtn) return;
  refreshBtn.disabled = loading;
  refreshBtn.innerText = loading ? '刷新中...' : BUTTON_TEXT_REFRESH;
}

function waitForRefreshResult(timeoutMs) {
  return new Promise((resolve) => {
    refreshResolver = resolve;
    refreshTimer = setTimeout(() => {
      const hasData = cachedApiRecords.length > 0;
      clearRefreshWaiter();
      resolve(hasData);
    }, timeoutMs);
  });
}

async function refreshCurrentPageData(showAlert = true) {
  captureEnabled = true;
  cachedApiRecords = [];
  lastCaptureAt = 0;
  lastCaptureUrl = '';
  refreshButtonCount();
  setRefreshButtonState(true);
  refreshInProgress = true;
  const queryBtn = findQueryButton();
  if (!queryBtn) {
    clearRefreshWaiter();
    setRefreshButtonState(false);
    if (showAlert) alert('未找到页面“查询”按钮，请确认当前在采购单列表页面。');
    return false;
  }
  queryBtn.click();
  const ok = await waitForRefreshResult(15000);
  setRefreshButtonState(false);
  if (!ok) {
    if (showAlert) alert('刷新超时，未获取到当前页面数据，请确认已完成查询。');
    return false;
  }
  if (showAlert) {
    const count = expandRecordsForPrint(cachedApiRecords).length;
    alert(`刷新完成，已获取 ${count} 条可打印数据。`);
  }
  return true;
}

function refreshButtonCount() {
  const btn = document.getElementById('sticker-print-btn');
  if (!btn) return;
  const printableCount = expandRecordsForPrint(cachedApiRecords).length;
  if (printableCount > 0) {
    btn.innerText = `${BUTTON_TEXT_PRINT} (${printableCount})`;
  } else {
    btn.innerText = BUTTON_TEXT_PRINT;
  }
}

function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

injectScript();
chrome.runtime.sendMessage({ type: 'INIT_MAIN_WORLD_INTERCEPTOR' }, (resp) => {
  mainWorldInjected = Boolean(resp?.ok);
  debugLog('拦截器注入状态', { ok: mainWorldInjected, isTopWindow });
  if (isTopWindow) refreshButtonCount();
});

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  
  if (event.data && event.data.type === 'STICKER_EXTENSION_TOKEN') {
    if (event.data.token) {
      currentAuthToken = event.data.token;
      debugLog('捕获到 Authorization Token', {
        token: maskToken(currentAuthToken)
      });
    }
    return;
  }

  if (!event.data || event.data.type !== 'STICKER_EXTENSION_INTERCEPT') return;

  const payload = event.data.payload || {};
  const records = Array.isArray(payload.records) ? payload.records : [];
  debugLog('收到接口拦截消息', {
    url: payload.url || '',
    records: records.length,
    captureEnabled,
    isTopWindow
  });
  if (!records.length) return;

  if (isTopWindow) {
    if (!captureEnabled) return;
    lastCaptureAt = Date.now();
    lastCaptureUrl = payload.url || '';
    if (isOrderListLikeUrl(lastCaptureUrl)) {
      cachedApiRecords = dedupeAndSort(records);
    } else {
      const merged = dedupeAndSort([...cachedApiRecords, ...records]);
      cachedApiRecords = merged;
    }
    debugLog('顶层窗口缓存更新', {
      lastCaptureUrl,
      mergedCount: cachedApiRecords.length
    });
    if (refreshInProgress && refreshResolver && (isOrderListLikeUrl(lastCaptureUrl) || cachedApiRecords.length > 0)) {
      const resolve = refreshResolver;
      clearRefreshWaiter();
      resolve(true);
    }
    refreshButtonCount();
  } else {
    chrome.runtime.sendMessage(
      {
        type: 'STICKER_RECORDS',
        payload: {
          url: payload.url || '',
          records
        }
      },
      () => {}
    );
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!isTopWindow) return;
  if (message?.type !== 'STICKER_RECORDS') return;
  const records = Array.isArray(message.payload?.records) ? message.payload.records : [];
  if (!records.length) return;
  if (!captureEnabled) return;
  lastCaptureAt = Date.now();
  lastCaptureUrl = message.payload?.url || '';
  if (isOrderListLikeUrl(lastCaptureUrl)) {
    cachedApiRecords = dedupeAndSort(records);
  } else {
    const merged = dedupeAndSort([...cachedApiRecords, ...records]);
    cachedApiRecords = merged;
  }
  if (refreshInProgress && refreshResolver && (isOrderListLikeUrl(lastCaptureUrl) || cachedApiRecords.length > 0)) {
    const resolve = refreshResolver;
    clearRefreshWaiter();
    resolve(true);
  }
  refreshButtonCount();
});

function generateStickers(items) {
  const container = document.createElement('div');
  container.id = 'sticker-print-area';

  items.forEach((item) => {
    const sticker = document.createElement('div');
    sticker.className = 'sticker-page';
    const colorType = [item.color, item.materialType].filter(Boolean).join(' / ');
    const skcText = item.skc || '';
    const skcClass = skcText.length > 20 ? 'header-value skc long-skc' : 'header-value skc';

    sticker.innerHTML = `
      <div class="sticker-content">
        <div class="sticker-header">
            <div class="sticker-line">
                <span class="header-label">订单编号：</span>
                <span class="header-value order-no">${item.orderNo || ''}</span>
            </div>
            <div class="sticker-line">
                <span class="header-label">SKC</span>
                <span class="header-colon">：</span>
                <span class="${skcClass}">${skcText}</span>
            </div>
        </div>
        
        <div class="sticker-body-table-wrapper">
            <table class="sticker-table">
                <tr>
                    <td class="td-label">采购单号：</td>
                    <td class="td-value">${item.purchaseOrderNo || ''}</td>
                </tr>
                <tr>
                    <td class="td-label">货　　号：</td>
                    <td class="td-value">${item.itemNo || ''}</td>
                </tr>
                <tr>
                    <td class="td-label">物料名称：</td>
                    <td class="td-value bold">${item.materialName || ''}</td>
                </tr>
                <tr>
                    <td class="td-label">颜色/类型：</td>
                    <td class="td-value">${colorType}</td>
                </tr>
                <tr>
                    <td class="td-label">下单日期：</td>
                    <td class="td-value">${item.purchaseDate || ''}</td>
                </tr>
                <tr>
                    <td class="td-label supplier-label">加 工 方：</td>
                    <td class="td-value supplier">${item.supplier || ''}</td>
                </tr>
            </table>
        </div>

        <div class="sticker-footer">
            <div class="footer-box">
                <span class="footer-label">供应商送货数：</span>
                <span class="footer-value">${item.deliveryQty || '0.00'}</span>
                <span class="footer-unit">${item.deliveryUnit || ''}</span>
            </div>
        </div>
      </div>
    `;

    container.appendChild(sticker);
  });

  return container;
}

async function fetchFactoryName(orderId) {
  if (!orderId || !currentAuthToken) {
    debugWarn('跳过加工方请求', {
      orderId,
      hasToken: Boolean(currentAuthToken)
    });
    return null;
  }
  
  try {
    const url = `https://yiyunapi.singbada.cn/apc/produce.ProduceProgress/detail?order_id=${orderId}`;
    debugLog('请求加工方接口', {
      orderId,
      url,
      token: maskToken(currentAuthToken)
    });
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': currentAuthToken,
        'Content-Type': 'application/json'
      }
    });
    
    debugLog('加工方接口HTTP响应', {
      orderId,
      status: resp.status,
      ok: resp.ok
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    const topLevelFactory = json?.data?.sewing_factory_name;
    const progressList = Array.isArray(json?.data?.progress) ? json.data.progress : [];
    const progressFactory = progressList
      .map((item) => item?.sewing_factory_name)
      .find((name) => name !== undefined && name !== null && String(name).trim() !== '');
    const factoryName = topLevelFactory || progressFactory || null;
    debugLog('加工方接口业务响应', {
      orderId,
      code: json?.code,
      msg: json?.msg,
      progressCount: progressList.length,
      factoryName: factoryName || '-'
    });
    if (json && (json.code === 200 || json.code === 0) && json.data) return factoryName;
  } catch (e) {
    debugError('请求加工方接口异常', {
      orderId,
      error: e?.message || String(e)
    });
  }
  return null;
}

function resolveOrderIdFromRecord(record) {
  const direct = pick(record, ['order_id', 'om_order_id', 'tc_order_id']);
  if (direct !== '') return String(direct).trim();
  return '';
}

function isPositiveIntegerString(value) {
  return /^\d+$/.test(String(value || '').trim());
}

async function fetchOrderIdByKeyword(keyword) {
  if (!keyword || !currentAuthToken) return null;
  try {
    const params = new URLSearchParams({
      page: '1',
      limit: '20',
      order_sn_style_sn: String(keyword)
    });
    const url = `https://yy.singbada.cn/api/apc/order.Order/index?${params.toString()}`;
    debugLog('通过关键词反查 order_id', { keyword, url });
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: currentAuthToken,
        'Content-Type': 'application/json'
      }
    });
    debugLog('反查 order_id HTTP响应', { keyword, status: resp.status, ok: resp.ok });
    if (!resp.ok) return null;
    const json = await resp.json();
    const first = json?.data?.list?.[0];
    const orderId = first?.order_id;
    debugLog('反查 order_id 业务响应', {
      keyword,
      code: json?.code,
      msg: json?.msg,
      orderId: orderId || '-'
    });
    return orderId ? String(orderId) : null;
  } catch (e) {
    debugError('反查 order_id 异常', {
      keyword,
      error: e?.message || String(e)
    });
    return null;
  }
}

async function handlePrint() {
  debugLog('开始打印流程', {
    cachedRecords: cachedApiRecords.length,
    hasToken: Boolean(currentAuthToken),
    token: maskToken(currentAuthToken),
    captureEnabled,
    lastCaptureUrl
  });
  if (!cachedApiRecords.length) {
    if (mainWorldInjected === false) {
      alert('拦截器未注入成功，请刷新页面并重新加载插件后再试。');
      return;
    }
    if (lastCaptureAt && lastCaptureUrl) {
      alert(`已接收到接口数据但未缓存成功：${lastCaptureUrl}`);
      return;
    }
    alert('未检测到接口数据，请先点击页面上的“查询”按钮刷新数据。');
    return;
  }

  const btn = document.getElementById('sticker-print-btn');
  const originalText = btn.innerText;
  btn.innerText = '正在获取加工方...';
  btn.disabled = true;

  try {
    const recordsToPrint = expandRecordsForPrint(cachedApiRecords);
    debugLog('展开后待打印记录数', recordsToPrint.length);
    
    if (currentAuthToken) {
        await Promise.all(recordsToPrint.map(async (record) => {
            let oid = resolveOrderIdFromRecord(record);
            const fallbackKeyword = pick(record, ['old_order_ids', 'old_order_id', 'order_sn', 'order_no', 'purchase_sn', 'style_sns', 'style_sn']);
            debugLog('准备获取加工方', {
              rawOrderId: oid || '-',
              fallbackKeyword: fallbackKeyword || '-',
              purchaseSn: pick(record, ['purchase_sn']) || '-',
              oldOrderId: pick(record, ['old_order_ids', 'old_order_id']) || '-'
            });
            if (!isPositiveIntegerString(oid) && fallbackKeyword) {
                const lookedUp = await fetchOrderIdByKeyword(fallbackKeyword);
                if (lookedUp) {
                  oid = lookedUp;
                  debugLog('反查到可用 order_id', { fallbackKeyword, orderId: oid });
                }
            }
            if (isPositiveIntegerString(oid)) {
              const factory = await fetchFactoryName(oid);
              if (factory) {
                record.sewing_factory_name = factory;
                debugLog('加工方获取成功', { orderId: oid, factory });
              } else {
                debugWarn('加工方获取为空', { orderId: oid });
              }
            } else {
              debugWarn('记录缺少可用数字 order_id，已跳过加工方请求', {
                rawOrderId: resolveOrderIdFromRecord(record) || '-',
                fallbackKeyword: fallbackKeyword || '-',
                purchaseSn: pick(record, ['purchase_sn']) || '-',
                oldOrderId: pick(record, ['old_order_ids', 'old_order_id']) || '-'
              });
            }
        }));
    } else {
        debugWarn('无可用 Token，跳过加工方请求');
    }

    const items = recordsToPrint
      .map(mapApiItemToSticker)
      .filter((item) => item.orderNo || item.purchaseOrderNo || item.materialName || item.itemNo);
    const missingSupplierCount = items.filter((item) => item.supplier === '-').length;
    debugLog('贴纸映射完成', {
      items: items.length,
      missingSupplierCount
    });

    if (!items.length) {
      alert('已捕获接口响应，但未匹配到可打印字段。');
      return;
    }

    const existing = document.getElementById('sticker-print-area');
    if (existing) {
      existing.remove();
    }

    const printArea = generateStickers(items);
    document.body.appendChild(printArea);
    debugLog('已生成打印区域并调用 window.print()');
    window.print();
  } catch (err) {
      debugError('打印流程异常', err);
      alert('打印处理出错: ' + err.message);
  } finally {
      btn.innerText = originalText;
      btn.disabled = false;
  }
}

function injectButton() {
  if (!isTargetPurchasingPage()) {
    removeActionButtons();
    return;
  }
  if (!document.getElementById('sticker-refresh-btn')) {
    const refreshBtn = document.createElement('button');
    refreshBtn.id = 'sticker-refresh-btn';
    refreshBtn.className = 'sticker-print-btn sticker-refresh-btn';
    refreshBtn.innerText = BUTTON_TEXT_REFRESH;
    refreshBtn.onclick = async () => {
      if (refreshInProgress) return;
      await refreshCurrentPageData(true);
    };
    document.body.appendChild(refreshBtn);
  }
  if (!document.getElementById('sticker-print-btn')) {
    const btn = document.createElement('button');
    btn.id = 'sticker-print-btn';
    btn.className = 'sticker-print-btn';
    btn.innerText = BUTTON_TEXT_PRINT;
    btn.onclick = async () => {
      if (!cachedApiRecords.length) {
        const ok = await refreshCurrentPageData(false);
        if (!ok) {
          alert('当前无可打印数据，请先点击“刷新数据”。');
          return;
        }
      }
      handlePrint();
    };
    document.body.appendChild(btn);
  }
  refreshButtonCount();
}

function runWhenBodyReady(fn) {
  if (document.body) {
    fn();
    return;
  }
  const obs = new MutationObserver(() => {
    if (document.body) {
      obs.disconnect();
      fn();
    }
  });
  obs.observe(document.documentElement, { childList: true });
}

if (isTopWindow) {
  runWhenBodyReady(() => {
    const observer = new MutationObserver(() => {
      if (!isTargetPurchasingPage()) {
        removeActionButtons();
        return;
      }
      if (!document.getElementById('sticker-print-btn') || !document.getElementById('sticker-refresh-btn')) {
        injectButton();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    injectButton();
  });
}