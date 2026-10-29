"use strict";
(function () {
  const b = document.getElementById("copy"), k = document.getElementById("newkey");
  if (!b || !k) return;
  b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(k.textContent); b.textContent = b.dataset.copied; }
    catch (e) { const r = document.createRange(); r.selectNodeContents(k); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = b.dataset.selected; }
  });
})();
