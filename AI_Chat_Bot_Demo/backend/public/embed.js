(function () {
  function getConfigScript() {
    // 1) prova currentScript
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
    var script = getConfigScript();
    if (!script) {
      console.warn("[Bot Widget] No config script found (data-bot-slug).");
      return;
    }

    var slug = script.getAttribute("data-bot-slug");
    var iconUrl = script.getAttribute("data-bot-icon");
    var position = script.getAttribute("data-bot-position") || "bottom-left";

    if (!slug) {
      console.warn("[Bot Widget] Missing data-bot-slug on script tag");
      return;
    }

    // prova a ricavare l'origin da src, così funziona su dev/prod
    var baseUrl;
    try {
      baseUrl = new URL(script.src).origin;
    } catch (e) {
      baseUrl = "";
    }

    console.log("[Bot Widget] init on", baseUrl, "slug=", slug);

    // --- launcher (icona) ---
    var launcher = document.createElement("button");
    launcher.type = "button";

    launcher.style.position = "fixed";
    launcher.style.zIndex = "2147483647";
    launcher.style.width = "56px";
    launcher.style.height = "56px";
    launcher.style.borderRadius = "28px";
    launcher.style.border = "none";
    launcher.style.cursor = "pointer";
    launcher.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";
    launcher.style.display = "flex";
    launcher.style.alignItems = "center";
    launcher.style.justifyContent = "center";
    launcher.style.padding = "0";
    launcher.style.backgroundColor = "#4f46e5";
    launcher.style.color = "#fff";
    launcher.style.touchAction = "manipulation";

    if (position === "bottom-left") {
      launcher.style.left = "16px";
      launcher.style.bottom = "16px";
    } else {
      launcher.style.right = "16px";
      launcher.style.bottom = "16px";
    }

    if (iconUrl) {
      var img = document.createElement("img");
      img.src = iconUrl;
      img.alt = "Chat bot";
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.objectFit = "cover";
      img.style.borderRadius = "50%";
      img.referrerPolicy = "no-referrer";
      launcher.appendChild(img);
    } else {
      launcher.textContent = "💬";
      launcher.style.fontSize = "24px";
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
      panel.style.bottom = "80px";
    } else {
      panel.style.right = "16px";
      panel.style.bottom = "80px";
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
    iframe.src = baseUrl + "/widget/" + encodeURIComponent(slug);
    iframe.style.border = "none";
    iframe.style.width = "100%";
    iframe.style.height = "calc(100% - 40px)";
    iframe.setAttribute("title", "Chat bot");
    iframe.setAttribute("loading", "lazy");
    panel.appendChild(iframe);

    launcher.addEventListener("click", function () {
      var isOpen = panel.style.display === "block";
      panel.style.display = isOpen ? "none" : "block";
    });

    document.body.appendChild(launcher);
    document.body.appendChild(panel);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
