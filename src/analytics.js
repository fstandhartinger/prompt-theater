(() => {
  const websiteId = "a6f294a8-c2bf-46ba-95b4-a1d3e0c3c8cd";
  const trackerUrl = "https://bh-analytics.app.mintapis.com/script.js";
  const trackerIntegrity =
    "sha384-ZMxgpYfO/phGz4GiYTIZhcauuGKTb2onmOB5gsiigjmBR38DGAmIna5J1Y/dM/13";
  const allowedHosts = new Set(["prompt-theater.app.mintapis.com"]);
  const pages = {
  "/": {
    "url": "/",
    "title": "Prompt Theater"
  },
  "/privacy": {
    "url": "/privacy",
    "title": "Privacy | Prompt Theater"
  },
  "/imprint": {
    "url": "/imprint",
    "title": "Imprint | Prompt Theater"
  }
};
  const { hostname, pathname } = window.location;
  const page = pages[pathname] || (/^\/scene\/\d+$/.test(pathname) ? {url: "/scene", title: "Scene | Prompt Theater"} : null);
  const doNotTrackValues = [
    navigator.doNotTrack,
    navigator.msDoNotTrack,
    window.doNotTrack,
  ];
  const doNotTrackEnabled = doNotTrackValues.some((value) =>
    /^(1|yes)$/i.test(String(value || "")),
  );

  if (
    !allowedHosts.has(hostname) ||
    !page ||
    doNotTrackEnabled ||
    navigator.globalPrivacyControl === true
  ) {
    return;
  }

  window.publicSiteUmamiBeforeSend = (type, payload) => {
    if (type !== "event" || !payload || typeof payload !== "object") return false;
    if (
      Object.prototype.hasOwnProperty.call(payload, "name") ||
      Object.prototype.hasOwnProperty.call(payload, "data") ||
      payload.website !== websiteId ||
      payload.url !== page.url
    ) {
      return false;
    }

    return {
      website: websiteId,
      hostname,
      url: page.url,
      title: page.title,
      referrer: "",
    };
  };

  const script = document.createElement("script");
  script.src = trackerUrl;
  script.integrity = trackerIntegrity;
  script.crossOrigin = "anonymous";
  script.referrerPolicy = "no-referrer";
  script.async = true;
  script.dataset.websiteId = websiteId;
  script.dataset.domains = [...allowedHosts].join(",");
  script.dataset.autoTrack = "false";
  script.dataset.doNotTrack = "true";
  script.dataset.excludeSearch = "true";
  script.dataset.excludeHash = "true";
  script.dataset.beforeSend = "publicSiteUmamiBeforeSend";
  script.addEventListener("load", () => {
    if (typeof window.umami?.track !== "function") return;

    window.umami.track({
      website: websiteId,
      hostname,
      url: page.url,
      title: page.title,
      referrer: "",
    });
  });
  document.head.appendChild(script);
})();
