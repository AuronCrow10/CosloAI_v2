(function () {
  if (window.__cosloGtagInit) {
    return;
  }
  window.__cosloGtagInit = true;

  var gaId = "G-ZZHXCFT7FW";
  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(gaId);
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = window.gtag || gtag;
  window.gtag("js", new Date());
  window.gtag("config", gaId, { send_page_view: false });
})();
