import { PUBLIC_BRAND, PUBLIC_CONTACT_EMAIL, PUBLIC_SITE } from "./config.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      default: return "&#39;";
    }
  });
}

export function page(title: string, body: string, logoUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#070807">
  <meta name="description" content="${escapeHtml(PUBLIC_BRAND)} searches OpenAlex, Semantic Scholar, PubMed, Crossref, and arXiv, then cites only the papers those APIs return.">
  <title>${escapeHtml(title)}</title>
  <link rel="icon" href="/logo.jpg" type="image/jpeg">
  <meta property="og:title" content="${escapeHtml(PUBLIC_BRAND)}">
  <meta property="og:image" content="${escapeHtml(logoUrl)}">
  <style>
    :root { color-scheme: dark; --bg:#070807; --card:#101612; --line:#234232; --text:#e8f6ec; --muted:#9db5a6; --accent:#3ddc84; --accent-2:#147a45; }
    * { box-sizing: border-box; }
    body { margin:0; background:radial-gradient(circle at 80% -10%, #143222 0, transparent 36%), var(--bg); color:var(--text); font:18px/1.6 "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
    a { color:var(--accent); }
    .shell { max-width:1040px; margin:0 auto; padding:28px 20px 80px; }
    header { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:36px; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:750; letter-spacing:-.03em; color:inherit; text-decoration:none; }
    .brand img { width:42px; height:42px; border-radius:10px; }
    nav { display:flex; gap:16px; flex-wrap:wrap; font-size:15px; }
    nav a { color:var(--muted); text-decoration:none; }
    nav a:hover { color:var(--text); }
    .hero { display:grid; grid-template-columns:1.3fr .7fr; gap:36px; align-items:center; }
    .eyebrow { color:var(--accent); font-size:13px; font-weight:750; letter-spacing:.14em; text-transform:uppercase; }
    h1 { font-size:clamp(40px, 6vw, 68px); line-height:.98; letter-spacing:-.045em; margin:10px 0 16px; }
    h2 { font-size:30px; letter-spacing:-.03em; margin:0 0 8px; }
    .lede { color:var(--muted); font-size:19px; max-width:640px; }
    .logo { width:min(100%, 320px); border-radius:24px; justify-self:end; }
    .actions { display:flex; gap:12px; flex-wrap:wrap; margin-top:24px; }
    .btn { appearance:none; border:0; border-radius:14px; padding:12px 16px; font:inherit; font-size:15px; font-weight:750; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; min-height:44px; cursor:pointer; }
    .primary { background:linear-gradient(135deg, var(--accent), var(--accent-2)); color:#062112; }
    .secondary { background:#132018; color:var(--text); border:1px solid var(--line); }
    .section { margin-top:64px; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:18px; }
    .grid.four { grid-template-columns:1fr 1fr 1fr 1fr; }
    .card { background:linear-gradient(180deg, #141c17, #0d120f); border:1px solid var(--line); border-radius:18px; padding:18px; }
    .card h3 { margin:0 0 6px; font-size:18px; }
    .card p, .card li { color:var(--muted); }
    code, pre { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background:#0b100e; border:1px solid var(--line); border-radius:14px; padding:14px; overflow:auto; font-size:14px; }
    .notice, .error { margin-top:16px; padding:12px 14px; border-radius:12px; }
    .notice { background:#102218; border:1px solid #245c3a; color:#c8f5d8; }
    .error { background:#2a1214; border:1px solid #6a3034; color:#ffc9c9; }
    label { display:block; margin:14px 0 6px; color:var(--muted); }
    input { width:100%; padding:12px; border-radius:10px; border:1px solid var(--line); background:#0b100e; color:inherit; font:inherit; }
    footer { margin-top:72px; padding-top:18px; border-top:1px solid var(--line); display:flex; gap:16px; flex-wrap:wrap; color:var(--muted); font-size:14px; }
    footer a { color:var(--muted); }
    :focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
    @media (max-width:800px) {
      .hero, .grid, .grid.four { grid-template-columns:1fr; }
      .logo { order:-1; justify-self:start; width:min(100%, 220px); }
      header { align-items:flex-start; flex-direction:column; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <a class="brand" href="/"><img src="/logo.jpg" alt="" width="42" height="42"> Papers</a>
      <nav>
        <a href="/connect">Connect</a>
        <a href="/account">Trial</a>
        <a href="/privacy">Privacy</a>
        <a href="/support">Support</a>
      </nav>
    </header>
    ${body}
    <footer>
      <span>${escapeHtml(PUBLIC_BRAND)}</span>
      <a href="${escapeHtml(PUBLIC_SITE)}">ouroborosapps.com</a>
      <a href="mailto:${escapeHtml(PUBLIC_CONTACT_EMAIL)}">${escapeHtml(PUBLIC_CONTACT_EMAIL)}</a>
      <a href="/connect">Connect an assistant</a>
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      <a href="/support">Support</a>
      <a href="/health">Health</a>
    </footer>
  </main>
</body>
</html>`;
}
