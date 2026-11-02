// Minimal stand-in for the GST portal "Search Taxpayer" page, for automated tests only.
// Same element ids as the real page (#for_gstin, #imgCaptcha, #fo-captcha, #lotsearch). Data is synthetic.
import http from 'node:http';

export const CAPTCHA = '482915';

function resultHtml(g, d) {
  return `<h4>Search Result based on GSTIN/UIN : ${g}</h4>
  <p><strong>Legal Name of Business</strong></p><p>${d.legal}</p>
  <p><strong>Trade Name</strong></p><p>${d.trade}</p>
  <p><strong>Effective Date of registration</strong></p><p>${d.reg}</p>
  <p><strong>Constitution of Business</strong></p><p>${d.cons}</p>
  <p><strong>GSTIN / UIN Status</strong></p><p>${d.status}</p>
  <p><strong>Taxpayer Type</strong></p><p>Regular</p>
  ${d.cancel ? `<p><strong>Effective Date of Cancellation</strong></p><p>${d.cancel}</p>` : ''}
  <p><strong>Administrative Office</strong></p><p>(JURISDICTION - STATE)</p><ul><li>State - Haryana</li><li>Ward - Test Ward</li></ul>
  <p><strong>Other Office</strong></p><p>(JURISDICTION - CENTER)</p><ul><li>Range - R-9</li></ul>
  <p><strong>Principal Place of Business</strong></p><p>${d.addr}</p>
  <p><strong>Nature Of Core Business Activity</strong></p><p>${d.core}</p>
  <p><strong>Nature of Business Activities</strong></p><ol>${d.nob.map((x, i) => `<li>${i + 1}.</li><li>${x}</li>`).join('')}</ol>
  <h4>Dealing In Goods and Services</h4><div>Goods</div><div>Services</div><div>HSN</div><div>Description</div>
  <table>${d.hsn.map(([c, t]) => `<tr><td>${c}</td><td>${t}</td></tr>`).join('')}</table>
  <div>HSN:</div><button>Show Filing Table</button>`;
}

export function startMockPortal(data, opts = {}) {
  const state = { down: false, searches: 0, noCaptcha: !!opts.noCaptcha };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (state.down) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<h1>Service Unavailable</h1>'); }
    if (u.pathname === '/services/searchtp') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><html><body><nav>e-Invoice News and Updates</nav><h2>Search Taxpayer</h2>
<input id="for_gstin"><div id="cap" style="display:none"><img id="imgCaptcha" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><input id="fo-captcha"><button id="lotsearch">SEARCH</button></div>
<div id="msg"></div><div id="out"></div>
<script>
const g=document.getElementById('for_gstin');
g.addEventListener('keydown',async e=>{ if(e.key!=='Enter')return; ${state.noCaptcha ? "search('" + CAPTCHA + "');" : "document.getElementById('cap').style.display='block';"} });
document.getElementById('lotsearch').onclick=()=>search(document.getElementById('fo-captcha').value);
async function search(c){ const r=await fetch('/api/search?g='+encodeURIComponent(g.value)+'&c='+c); const t=await r.text();
  if(r.status===400){document.getElementById('msg').textContent='Enter valid Letters shown.';return;}
  document.getElementById('out').innerHTML=t; }
</script></body></html>`);
    }
    if (u.pathname === '/api/search') {
      state.searches++;
      const g = u.searchParams.get('g'); const c = u.searchParams.get('c');
      if (c !== CAPTCHA) { res.writeHead(400); return res.end('bad captcha'); }
      const d = data[g];
      if (d === 'hang') { return; }     // never answers -> timeout
      res.writeHead(200, { 'content-type': 'text/html' });
      if (!d) return res.end('<div class="err">No records found for the provided GSTIN/UIN</div>');
      if (d === 'garbage') return res.end('<div>Something changed on this page '+g+'</div><p>Legal Name of Business</p>');
      return res.end(resultHtml(g, d));
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}/services/searchtp`, state, close: () => new Promise(z => { server.closeAllConnections?.(); server.close(z); }) })));
}
