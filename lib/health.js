const TIMEOUT_MS = 12000;

export async function checkSite(url) {
  if (!url) return { ok: null, status: null, ms: null, error: 'no url configured' };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // GET rather than HEAD: plenty of hosts and WAFs return 403/405 for HEAD
    // and we would report a healthy site as broken.
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Meerkat-Monitor/1.0' },
    });
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - started,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message;
    return { ok: false, status: null, ms: Date.now() - started, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
