(function(){
  var metaKey = (document.querySelector('meta[name=\"page\"]')?.getAttribute('content') || '').toLowerCase();
  var path = location.pathname.replace(/\/+$/,'').toLowerCase();

  function buildHeader(){
    var header = document.createElement('header');
    header.className = 'site-header';
    header.setAttribute('role','banner');
    header.innerHTML = [
      '<div class=\"bar\">',
        '<a class=\"brand\" href=\"/ui/\">',
          '<svg class=\"dna\" viewBox=\"0 0 24 24\" fill=\"none\" aria-hidden=\"true\">',
            '<defs>',
              '<linearGradient id=\"g-dna\" x1=\"0\" y1=\"0\" x2=\"24\" y2=\"24\">',
                '<stop stop-color=\"var(--grad-from)\"></stop>',
                '<stop offset=\"1\" stop-color=\"var(--grad-to)\"></stop>',
              '</linearGradient>',
            '</defs>',
            '<path d=\"M5 4c4 0 6 4 7 8s3 8 7 8M5 20c4 0 6-4 7-8S15 4 19 4\" stroke=\"url(#g-dna)\" stroke-width=\"2\" stroke-linecap=\"round\"></path>',
            '<path d=\"M7 8h10M7 16h10\" stroke=\"url(#g-dna)\" stroke-width=\"2\" stroke-linecap=\"round\" opacity=\".75\"></path>',
          '</svg>',
          '<span class=\"title\">ImmunoStream</span>',
        '</a>',
        '<nav class=\"nav\" aria-label=\"Primary\">',
          '<a class=\"nav-link\" data-key=\"home\" href=\"/ui/\">Home</a>',
          '<a class=\"nav-link\" data-key=\"bulk\" href=\"/ui/blk.html\">Bulk amplicon</a>',
          '<a class=\"nav-link\" data-key=\"sc\" href=\"/ui/sc.html\">Single-Cell AIRR</a>',
          '<a class=\"nav-link\" data-key=\"docs\" href=\"/ui/docs.html\">Documents</a>',
        '</nav>',
      '</div>'
    ].join('');
    return header;
  }

  function detectKey(){
    if (metaKey) return metaKey;
    if (path.endsWith('/ui') || path.endsWith('/ui/index.html') || path === '/ui') return 'home';
    if (path.endsWith('/blk.html')) return 'bulk';
    if (path.endsWith('/sc.html')) return 'sc';
    if (path.endsWith('/docs.html')) return 'docs';
    return '';
  }

  function highlight(header, key){
    if (!key || !header) return;
    var el = header.querySelector('.nav-link[data-key=\"'+key+'\"]');
    if (el) el.classList.add('active');
  }

  var headerEl = document.querySelector('.site-header');
  if (!headerEl) {
    headerEl = buildHeader();
    document.body.insertBefore(headerEl, document.body.firstChild);
  }

  document.body.classList.add('has-site-header');
  highlight(headerEl, detectKey());
})();
