(function () {
  if (window.__cosloGtagInit) {
    return;
  }

  var consent = null;
  try {
    consent = window.localStorage.getItem("coslo_cookie_consent");
  } catch (err) {
    consent = null;
  }

  if (consent !== "accepted") {
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
  window["ga-disable-" + gaId] = false;
  window.gtag("consent", "default", {
    analytics_storage: "granted"
  });
  window.gtag("js", new Date());
  window.gtag("config", gaId, { send_page_view: true });
})();

