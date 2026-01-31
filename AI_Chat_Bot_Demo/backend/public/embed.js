(function () {
  function getConfigScript() {
    // 1) currentScript
    if (document.currentScript) {
      return document.currentScript;
    }

    // 2) fallback: cerca uno script con data-bot-slug
    var scripts = document.querySelectorAll("script[data-bot-slug]");
    if (scripts.length > 0) {
      return scripts[scripts.length - 1]; // l'ultimo
    }

    return null;
  }

  function init() {
    if (window.self !== window.top) {
      // Prevent embedding the launcher inside the widget iframe
      return;
    }
    var script = getConfigScript();
    if (!script) {
      console.warn("[Bot Widget] No config script found (data-bot-slug).");
      return;
    }

    var slug = script.getAttribute("data-bot-slug");
    var iconUrl = script.getAttribute("data-bot-icon");
    var defaultIconUrl = "https://i.ibb.co/cczVssVz/test.gif";
    var position = script.getAttribute("data-bot-position") || "bottom-left";

    // NEW: optional language parameter (default: "en")
    var lang = script.getAttribute("data-bot-lang") || "en";

    console.log(iconUrl);

    // optional: attention sentences (separated by "|")
    // es: data-bot-hints="Serve aiuto?|Fai una domanda|Parla con me 🙂"
    var hintsAttr = script.getAttribute("data-bot-hints");
    var hints = hintsAttr
      ? hintsAttr
          .split("|")
          .map(function (h) {
            return h.trim();
          })
          .filter(Boolean)
      : [
          "Hai bisogno di una mano ?",
          "Fai una domanda, sono qui 👋",
          "Vuoi un consiglio veloce?",
          "Scrivimi, rispondo subito!",
        ];

    // prova a ricavare l'origin da src, cosÃ¬ funziona su dev/prod
    var baseUrl;
    try {
      baseUrl = new URL(script.src).origin;
    } catch (e) {
      baseUrl = "";
    }
    if (!slug) {
      var shopParam = null;
      try {
        shopParam = new URL(script.src).searchParams.get("shop");
      } catch (e) {
        shopParam = null;
      }

      if (!shopParam) {
        console.warn("[Bot Widget] Missing data-bot-slug on script tag.");
        return;
      }

      fetch(
        baseUrl +
          "/api/shopify/widget-config?shop=" +
          encodeURIComponent(shopParam)
      )
        .then(function (res) {
          if (!res.ok) throw new Error("Widget config fetch failed");
          return res.json();
        })
        .then(function (payload) {
          startWidget(payload.botSlug, {
            shop: shopParam,
            botId: payload.botId,
            widgetToken: payload.widgetToken || null
          });
        })
        .catch(function (err) {
          console.warn("[Bot Widget] Failed to resolve shop config.", err);
        });
      return;
    }

    function startWidget(resolvedSlug, shopMeta) {
      slug = resolvedSlug;
      console.log("[Bot Widget] init on", baseUrl, "slug", slug);

    var launcher = document.createElement("button");
    launcher.type = "button";

    launcher.style.position = "fixed";
    launcher.style.zIndex = "2147483647";

    // No circle/background; keep only the image
    launcher.style.width = "auto";
    launcher.style.height = "auto";
    launcher.style.borderRadius = "0";
    launcher.style.backgroundColor = "transparent";
    launcher.style.backgroundImage = "none";

    launcher.style.border = "none";
    launcher.style.cursor = "pointer";
    launcher.style.boxShadow = "none";
    launcher.style.display = "flex";
    launcher.style.alignItems = "center";
    launcher.style.justifyContent = "center";
    launcher.style.padding = "0";
    launcher.style.color = "#4f46e5";
    launcher.style.touchAction = "manipulation";
    launcher.style.transition =
      "transform 0.15s ease-out, box-shadow 0.15s ease-out";

    if (position === "bottom-left") {
      launcher.style.left = "16px";
      launcher.style.bottom = "16px";
    } else {
      launcher.style.right = "16px";
      launcher.style.bottom = "16px";
    }

    launcher.addEventListener("mouseenter", function () {
      launcher.style.transform = "translateY(-2px) scale(1.04)";
    });
    launcher.addEventListener("mouseleave", function () {
      launcher.style.transform = "translateY(0) scale(1)";
    });

    console.warn(iconUrl);
    if (!iconUrl) {
      iconUrl = defaultIconUrl;
    }

    if (iconUrl) {
      var img = document.createElement("img");
      img.src = iconUrl; // GIF
      img.alt = "Chat bot";

      // Size the image directly (button stays transparent)
      img.style.width = "100px";
      img.style.height = "100px";
      img.style.objectFit = "contain";

      // keep it nicely centered, no extra clipping
      img.style.display = "block";

      // transparency works with white circle behind
      img.style.borderRadius = "0"; // we already have a circular button
      img.referrerPolicy = "no-referrer";
      launcher.appendChild(img);
    } else {
      launcher.textContent = "💬";
      launcher.style.fontSize = "32px";
      launcher.style.backgroundColor = "#4f46e5";
      launcher.style.color = "#fff";
    }

    // --- pannello ---
    var panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.zIndex = "2147483647";
    panel.style.width = "380px";
    panel.style.height = "560px";
    panel.style.maxWidth = "95vw";
    panel.style.maxHeight = "80vh";
    panel.style.borderRadius = "16px";
    panel.style.boxShadow = "0 8px 32px rgba(0,0,0,0.25)";
    panel.style.backgroundColor = "#ffffff";
    panel.style.overflow = "hidden";
    panel.style.display = "none";

    if (position === "bottom-left") {
      panel.style.left = "16px";
      panel.style.bottom = "90px";
    } else {
      panel.style.right = "16px";
      panel.style.bottom = "90px";
    }

    var header = document.createElement("div");
    header.style.height = "40px";
    header.style.background = "#4f46e5";
    header.style.color = "#fff";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.padding = "0 10px";
    header.style.fontFamily = "system-ui, sans-serif";
    header.style.fontSize = "14px";

    var title = document.createElement("span");
    title.textContent = "Chat";
    header.appendChild(title);

    var closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.style.border = "none";
    closeBtn.style.background = "transparent";
    closeBtn.style.color = "#fff";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "16px";
    closeBtn.style.padding = "0";

    closeBtn.onclick = function () {
      panel.style.display = "none";
    };

    header.appendChild(closeBtn);
    panel.appendChild(header);

    var iframe = document.createElement("iframe");

    // NEW: pass lang as query param to the widget
    var widgetUrl = baseUrl + "/widget/" + encodeURIComponent(slug);
    if (lang) {
      var sep = widgetUrl.indexOf("?") === -1 ? "?" : "&";
      widgetUrl += sep + "lang=" + encodeURIComponent(lang);
    }
    if (shopMeta && shopMeta.shop) {
      var sepShop = widgetUrl.indexOf("?") === -1 ? "?" : "&";
      widgetUrl += sepShop + "shop=" + encodeURIComponent(shopMeta.shop);
    }
    if (shopMeta && shopMeta.botId) {
      var sepBot = widgetUrl.indexOf("?") === -1 ? "?" : "&";
      widgetUrl += sepBot + "botId=" + encodeURIComponent(shopMeta.botId);
    }
    if (shopMeta && shopMeta.widgetToken) {
      var sepToken = widgetUrl.indexOf("?") === -1 ? "?" : "&";
      widgetUrl += sepToken + "wt=" + encodeURIComponent(shopMeta.widgetToken);
    }
    iframe.src = widgetUrl;

    iframe.style.border = "none";
    iframe.style.width = "100%";
    iframe.style.height = "calc(100% - 40px)";
    iframe.setAttribute("title", "Chat bot");
    iframe.setAttribute("loading", "lazy");
    panel.appendChild(iframe);

    launcher.addEventListener("click", function () {
      var isOpen = panel.style.display === "block";
      panel.style.display = isOpen ? "none" : "block";
      // hide hint bubble when opening/closing
      hideHint();
    });

    document.body.appendChild(launcher);
    document.body.appendChild(panel);

    // --- hint bubble (frasi che cambiano) ---
    var hintBubble = document.createElement("div");
    hintBubble.style.position = "fixed";
    hintBubble.style.zIndex = "2147483646";
    hintBubble.style.maxWidth = "260px";
    hintBubble.style.padding = "8px 12px";
    hintBubble.style.borderRadius = "999px";
    hintBubble.style.background = "#ffffff";
    hintBubble.style.boxShadow = "0 8px 24px rgba(0,0,0,0.18)";
    hintBubble.style.fontFamily = "system-ui, sans-serif";
    hintBubble.style.fontSize = "13px";
    hintBubble.style.lineHeight = "1.4";
    hintBubble.style.color = "#111827";
    hintBubble.style.opacity = "0";
    hintBubble.style.transform = "translateY(10px)";
    hintBubble.style.pointerEvents = "none";
    hintBubble.style.transition =
      "opacity 0.25s ease-out, transform 0.25s ease-out";

    if (position === "bottom-left") {
      hintBubble.style.left = "90px";
      hintBubble.style.bottom = "32px";
    } else {
      hintBubble.style.right = "90px";
      hintBubble.style.bottom = "32px";
    }

    document.body.appendChild(hintBubble);

    var hintTimeoutId = null;
    var hintIntervalId = null;

    function hideHint() {
      hintBubble.style.opacity = "0";
      hintBubble.style.transform = "translateY(10px)";
      if (hintTimeoutId) {
        window.clearTimeout(hintTimeoutId);
        hintTimeoutId = null;
      }
    }

    function showHint() {
      // non disturbare se la chat è aperta o non ci sono messaggi
      if (panel.style.display === "block" || !hints.length) return;

      var msg = hints[Math.floor(Math.random() * hints.length)];
      hintBubble.textContent = msg;
      hintBubble.style.opacity = "1";
      hintBubble.style.transform = "translateY(0)";

      if (hintTimeoutId) {
        window.clearTimeout(hintTimeoutId);
      }
      hintTimeoutId = window.setTimeout(hideHint, 5000); // nasconde dopo 5s
    }

    function startHints() {
      // niente hint su schermi piccolissimi
      if (window.innerWidth < 480) return;

      // primo hint dopo 8s, poi ogni 20s
      window.setTimeout(showHint, 8000);
      hintIntervalId = window.setInterval(showHint, 20000);
    }

    startHints();
    }

    startWidget(slug);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
