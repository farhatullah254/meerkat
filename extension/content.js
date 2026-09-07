(() => {
  const POLL_MS = 15_000;
  const HOST_ID = 'meerkat-live-overlay';
  if (document.getElementById(HOST_ID)) return;

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: none;
      font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
      transition: opacity 160ms ease;
    }
    .wrap[data-corner="bottom-right"] { right: 16px; bottom: 16px; align-items: flex-end; }
    .wrap[data-corner="top-right"]    { right: 16px; top: 16px;    align-items: flex-end; }
    .wrap[data-corner="bottom-left"]  { left: 16px;  bottom: 16px; align-items: flex-start; }
    .wrap[data-corner="top-left"]     { left: 16px;  top: 16px;    align-items: flex-start; }

    .card {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 168px;
      max-width: 280px;
      padding: 7px 10px;
      border-radius: 10px;
      background: rgba(16, 18, 23, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.10);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px) saturate(1.2);
      -webkit-backdrop-filter: blur(10px) saturate(1.2);
      color: #f2f4f8;
      cursor: pointer;
      transition: transform 140ms ease, background 140ms ease;
    }
    .card:hover { transform: translateY(-1px); background: rgba(16, 18, 23, 0.94); }

    .dot { width: 7px; height: 7px; border-radius: 50%; background: #35d07f; flex: 0 0 auto; }
    .dot.warm { background: #ffb020; }
    .name {
      flex: 1 1 auto;
      font-size: 12px;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      letter-spacing: 0.01em;
    }
    .count { font-size: 14px; font-weight: 650; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
    .total {
      pointer-events: auto;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: rgba(255, 255, 255, 0.62);
      background: rgba(16, 18, 23, 0.72);
      border-radius: 6px;
      padding: 3px 8px;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    @media (prefers-reduced-motion: reduce) { .wrap, .card { transition: none; } }
  `;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:static;';
  const root = host.attachShadow({ mode: 'open' });

  // adoptedStyleSheets is not subject to the page's style-src CSP; the <style>
  // fallback covers browsers that reject a constructed sheet.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
  }

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(wrap);

  let restOpacity = 0.72;
  let mounted = false;
  const mount = () => {
    if (mounted || !document.documentElement) return;
    document.documentElement.appendChild(host);
    mounted = true;
  };
  const unmount = () => {
    if (!mounted) return;
    host.remove();
    mounted = false;
  };

  const render = (res) => {
    if (!res?.show || !res.sites?.length) return unmount();

    const cfg = res.cfg ?? {};
    wrap.dataset.corner = cfg.corner ?? 'bottom-right';
    restOpacity = Number(cfg.opacity ?? 0.72);
    wrap.style.opacity = String(restOpacity);
    wrap.replaceChildren();

    for (const site of res.sites) {
      const card = document.createElement('div');
      card.className = 'card';
      card.title = `${site.name} — ${site.active} active now. Click to open Meerkat.`;

      const dot = document.createElement('span');
      dot.className = site.active >= 10 ? 'dot warm' : 'dot';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = site.name;

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = String(site.active);

      card.append(dot, name, count);
      card.addEventListener('click', () => {
        window.open(cfg.meerkatUrl ?? 'http://localhost:3000', '_blank', 'noopener');
      });
      wrap.appendChild(card);
    }

    if (res.total > 0) {
      const total = document.createElement('div');
      total.className = 'total';
      total.textContent = `${res.total} active across network`;
      wrap.appendChild(total);
    }

    mount();
  };

  const tick = () => {
    try {
      chrome.runtime.sendMessage({ type: 'meerkat:state', host: location.hostname }, (res) => {
        // The context is gone after an extension reload; stop rather than throw.
        if (chrome.runtime.lastError) return unmount();
        render(res);
      });
    } catch {
      unmount();
    }
  };

  // Full opacity while the pointer is over the stack, so a glance is readable
  // without the cards competing with the page the rest of the time.
  wrap.addEventListener('mouseenter', () => { wrap.style.opacity = '1'; });
  wrap.addEventListener('mouseleave', () => { wrap.style.opacity = String(restOpacity); });

  tick();
  setInterval(tick, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
