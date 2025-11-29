// src/utils/facebookSdk.ts
declare global {
  interface Window {
    fbAsyncInit?: () => void;
    FB?: any;
  }
}

let sdkLoadingPromise: Promise<any> | null = null;

export function loadFacebookSdk(appId: string): Promise<any> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("FB SDK can only be loaded in the browser"));
  }

  if (window.FB) {
    return Promise.resolve(window.FB);
  }

  if (sdkLoadingPromise) {
    return sdkLoadingPromise;
  }

  sdkLoadingPromise = new Promise((resolve, reject) => {
    window.fbAsyncInit = function () {
      window.FB?.init({
        appId,
        xfbml: false,
        version: "v22.0"
      });
      resolve(window.FB);
    };

    const scriptId = "facebook-jssdk";
    if (document.getElementById(scriptId)) {
      return;
    }

    const js = document.createElement("script");
    js.id = scriptId;
    js.src = "https://connect.facebook.net/en_US/sdk.js";
    js.onerror = (err) => {
      console.error("Failed to load Facebook SDK", err);
      reject(err);
    };

    const fjs = document.getElementsByTagName("script")[0];
    if (fjs && fjs.parentNode) {
      fjs.parentNode.insertBefore(js, fjs);
    } else {
      document.head.appendChild(js);
    }
  });

  return sdkLoadingPromise;
}
