/* apply a stored theme choice before first paint; with no choice the page follows prefers-color-scheme.
   A separate classic script in the head, not an inline one: the page's content security policy allows no inline script. */
try { var t = localStorage.getItem('boxd-theme'); if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage blocked */ }
