// CORS proxy for RSS/Atom feeds. The browser can't fetch feeds cross-origin,
// so the client builds briefings through here. Only http(s) URLs; the key
// insight is this proxy holds no secrets — it just forwards bytes.
const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[::1\])/i;

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost').searchParams.get('url');
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Provide a url query parameter starting with http(s).' });
  }
  let host = '';
  try { host = new URL(url).hostname; } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (BLOCKED.test(host)) return res.status(403).json({ error: 'That host is not allowed.' });

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'MorningBrief/1.0 (+https://morningbrief.app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    const text = await upstream.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/xml');
    return res.status(upstream.status).send(text);
  } catch (err) {
    return res.status(502).json({ error: `Fetch failed: ${err.message}` });
  }
}
